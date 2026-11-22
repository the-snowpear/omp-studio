import type { RuntimeFeatureResultMap } from "@omp-studio/studio-protocol";
import { PREVIEW_TASK_SPAWN_OPTIONS } from "./preview/taskSpawnPreview";
import { SlidingTabs } from "./SlidingTabs";
import { AppSelect } from "./AppSelect";
import { AgentModelDetails } from "./models/AgentModelDetails";
import { getPreviewAgentDefinitions } from "./preview/agentSpawnPreview";
import { ModelDelegationList } from "./ModelDelegationList";
import { AgentBtwPane } from "./btw/AgentBtwPane";
import { ServicesPane } from "./services/ServicesPane";
import { WorkspacePanel, WorkspaceTabs } from "./workspaces/Workspace";
import { useI18n } from "./i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ClientBootstrap, CommandInput, CommandName, SessionId, StudioClient } from "@omp-studio/client-contract";
import type { AgentId, AgentTranscriptMessage, OpaqueCursor, OperatorStateSnapshot, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { agentJobTree, buildJobTree, type JobTreeRow } from "./conversation/jobTree";
import type { MentionCandidate } from "./composer/types";
import { RuntimeLossBanner } from "./RuntimeLossBanner";
import { Icon } from "./icons";
import { buildPreviewHub } from "./hubPreview";
import type { PreviewMetrics } from "./hubPreview";
import { usePreviewMode } from "./preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { SubagentConversationPane } from "./conversation/SubagentConversationPane";
import { tabPaneRole, useOverlappingTabs } from "./pageTransition";
import { motionReduced } from "./motion";
import { type HubTab } from "./pageIntents";
import { clearHubIntent, loadPersisted, persist, readHubIntent } from "./agents/hub/navigation";
import { type HubAgent, type HubJob, type HubStatus, type HubView, type Modal, type Notice } from "./agents/hub/types";
import { contractFor, capsFor, missingCap } from "./agents/hub/capabilities";
import { STATUS_DOT, STATUS_LABEL, TABS, fmtClock, fmtCost, fmtDur, fmtNum, fromPreviewAgent, fromPreviewJob, hubChatTarget, hubComposerAgents, hubSelectorId, hubWord, linearSeq, sortByCreation, toHubAgent, toHubJob, treeGroups } from "./agents/hub/projection";
import { hubFaceClass, useHubChatCloseMotion } from "./agents/hub/useHubChatMotion";
import { AgentCard, EmptyBlock, KbdHint, TreeGroup } from "./agents/hub/AgentCards";
import { HubAgentOverview } from "./agents/hub/HubAgentOverview";
import { HubDossierHead, HubSigil, HubStatusPill } from "./agents/hub/HubDossier";
import { HubJobRow } from "./agents/hub/HubJobRow";
import { TaskAssignmentEditor, createTaskStep, type TaskAssignmentMode, type TaskStepDraft } from "./agents/TaskAssignmentEditor";
import { TaskStepsView } from "./agents/TaskStepsView";
import { previewTaskStepsForAgent } from "./preview/taskStepsPreview";
import { getPreviewDockAgents } from "./preview/agentDockPreview";
import { AgentDeck, type DeckEmbedding, type DeckLinks } from "./agents/deck/AgentDeck";
import { buildDeck, type DeckAgent } from "./agents/deck/deckModel";
import { CommsView } from "./agents/deck/CommsView";
import { rosterKeyOf, useSwarmComms } from "./agents/deck/comms";
import { agentSwarmScope } from "./agents/deck/swarmScope";

export type { HubView } from "./agents/hub/types";

export { HUB_INTENT_KEY, setHubIntent, type HubTab, type HubIntentTab } from "./pageIntents";

export function AgentHubPage({
  snapshot,
  runtime,
  resyncRequired,
  capabilities,
  client,
  canSend,
  runtimeConnected,
  agents,
  persistedReady = true,
  parentSessionId,
  liveSessionId,
  pendingInteraction,
  workspaceId,
  loadMentions,
  swarmScope,
  onOpenMain,
  onOpenDiagnostics,
}: {
  snapshot?: OperatorStateSnapshot;
  runtime?: ClientBootstrap["runtime"];
  resyncRequired?: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"];
  client?: StudioClient;
  canSend?: boolean;
  runtimeConnected?: boolean;
  agents?: readonly StudioAgentSnapshot[];
  persistedReady?: boolean;
  parentSessionId?: SessionId;
  liveSessionId?: SessionId;
  pendingInteraction?: boolean;
  workspaceId?: string;
  loadMentions?: (
    trigger: "@" | "/" | "^",
    query: string,
  ) => Promise<readonly MentionCandidate[]>;
  /** The workbench deck's recorder scope, so the Hub's deck replays the same history. */
  swarmScope?: string;
  onOpenMain: () => void;
  onOpenDiagnostics?: () => void;
}) {
  const initial = useMemo(loadPersisted, []);
  const sessionKey = parentSessionId ?? "";
  const [selectedBySession, setSelectedBySession] = useState<
    Record<string, string>
  >(initial.selectedBySession);
  const selected = selectedBySession[sessionKey] ?? null;
  const [tab, setTab] = useState<HubTab>(initial.tab);
  // The Hub always opens on the command deck; the card views are a click away.
  const [view, setView] = useState<HubView>("deck");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [now, setNow] = useState(Date.now());
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth <= 900,
  );
  const [busyCount, setBusyCount] = useState(0);
  const busyCountRef = useRef(0);
  const commandBusy = busyCount > 0;
  const [draftsByAgent, setDraftsByAgent] = useState<Record<string, string>>({});
  const [transcriptRefresh, setTranscriptRefresh] = useState(0);
  const [spawnTask, setSpawnTask] = useState("");
  const [spawnEffort, setSpawnEffort] = useState("");
  const [spawnModel, setSpawnModel] = useState("");
  const [spawnMode, setSpawnMode] = useState<TaskAssignmentMode>("single");
  const [spawnSteps, setSpawnSteps] = useState<TaskStepDraft[]>(() => [createTaskStep()]);
  const [spawnOptions, setSpawnOptions] = useState<RuntimeFeatureResultMap["agent.spawn.options"]>();
  const [spawnOptionsError, setSpawnOptionsError] = useState("");
  const spawnLock = useRef(false);
  const spawnEpoch = useRef(0);
  const [spawnSolutionSpace, setSpawnSolutionSpace] = useState("");
  const [spawnDefinition, setSpawnDefinition] = useState("");
  const [spawnDefinitions, setSpawnDefinitions] = useState<ReadonlyArray<{
    name: string;
    description: string;
    model?: readonly string[];
  }> | null>(null);
  const [transcriptPage, setTranscriptPage] = useState<{
    agentId: string;
    generation: number;
    messages: AgentTranscriptMessage[];
    nextCursor?: string;
    eof: boolean;
  } | null>(null);
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // The sticky dossier sits under the sticky workspace tab bar and fits what is
  // left of the page's scroll area; both heights depend on the window chrome.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const scroller = root?.closest<HTMLElement>(".page-body");
    if (!root || !scroller) return;
    const measure = () => {
      const bar = root.querySelector<HTMLElement>(":scope > .workspace-tabbar");
      root.style.setProperty("--hub-scroll-h", `${scroller.clientHeight}px`);
      root.style.setProperty("--hub-bar-h", `${bar?.offsetHeight ?? 0}px`);
      // Content under the columns ends the sticky range early; leave room for it
      // so the dossier is never pushed under the tab bar at the end of the page.
      const cols = colsRef.current;
      if (cols) {
        const bottom = cols.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + scroller.scrollTop;
        root.style.setProperty("--hub-tail-h", `${Math.max(0, Math.round(scroller.scrollHeight - bottom))}px`);
      }
    };
    measure();
    const Observer = root.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(scroller);
    observer.observe(root);
    const bar = root.querySelector<HTMLElement>(":scope > .workspace-tabbar");
    if (bar) observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const transcriptReq = useRef(0);

  useEffect(() => {
    persist({ selectedBySession, tab });
  }, [selectedBySession, tab]);

  useEffect(() => {
    if (parentSessionId === undefined) return;
    setSelectedBySession((prev) => {
      if (prev[parentSessionId] !== undefined || prev[""] === undefined)
        return prev;
      const next = { ...prev, [parentSessionId]: prev[""] };
      delete next[""];
      return next;
    });
  }, [parentSessionId]);

  const sessionKeyRef = useRef(sessionKey);
  useEffect(() => {
    if (sessionKeyRef.current === sessionKey) return;
    sessionKeyRef.current = sessionKey;
    setChatOpen(false);
    setDrawerOpen(false);
  }, [sessionKey]);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const { preview, marks } = usePreviewMode();
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const deckWords = useCallback((key: string, params?: Record<string, string | number>) => t(`agentDeck.${key}`, params), [t]);
  const zhRef = useRef(zh);
  zhRef.current = zh;
  const contract = contractFor(zh);
  const [workspaceTab, setWorkspaceTab] = useState<
    "agents" | "jobs" | "services"
  >("agents");
  const runtimeStatus = runtime?.status ?? "unavailable";
  const connOnline = runtimeStatus === "connected" && !resyncRequired;
  const viewingLive =
    parentSessionId === undefined || snapshot?.sessionId === parentSessionId;
  const liveClock = preview || (connOnline && viewingLive);
  useEffect(() => {
    if (!liveClock) return;
    let timer: number | undefined;
    const isVisible = () => !document.hidden && document.visibilityState !== "hidden";
    const start = () => {
      if (timer !== undefined || !isVisible()) return;
      timer = window.setInterval(() => {
        if (isVisible()) setNow(Date.now());
      }, 5000);
    };
    const stop = () => {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    const onVisibility = () => {
      if (!isVisible()) {
        stop();
      } else {
        setNow(Date.now());
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [liveClock]);
  const spawnAvailable =
    preview ||
    (viewingLive &&
      connOnline &&
      client !== undefined &&
      !missingCap(capabilities, "agent.spawn"));
  const spawnTip = preview
    ? marks ? zh ? "演示创建，不会执行任务" : "Preview creation; no task runs" : undefined
    : !viewingLive ? contract.historicalWrite : missingCap(capabilities, "agent.spawn") ? contract.spawn : undefined;
  useEffect(() => {
    spawnEpoch.current++;
    spawnLock.current = false;
    if (preview) {
      const previewDefs = getPreviewAgentDefinitions(zhRef.current);
      setSpawnDefinitions(previewDefs);
      setSpawnDefinition(previewDefs[0]?.name ?? "");
    } else {
      setSpawnDefinitions(null);
      setSpawnDefinition("");
    }
    setSpawnEffort("");
    return () => {
      spawnEpoch.current++;
    };
  }, [client, preview, parentSessionId, snapshot?.sessionId]);
  useEffect(() => {
    if (!preview) return;
    const previewDefs = getPreviewAgentDefinitions(zh);
    setSpawnDefinitions(previewDefs);
    setSpawnDefinition((current) =>
      previewDefs.some((item) => item.name === current) ? current : (previewDefs[0]?.name ?? ""),
    );
  }, [preview, zh]);
  useEffect(() => {
    let alive = true;
    setSpawnOptions(undefined); setSpawnOptionsError(""); setSpawnModel(""); setSpawnEffort("");
    if (modal?.kind !== "spawn" || !spawnDefinition) return;
    if (preview) { setSpawnOptions(PREVIEW_TASK_SPAWN_OPTIONS); return; }
    if (!client || !snapshot?.sessionId || missingCap(capabilities, "agent.spawn.options")) return;
    void client.query("agent.spawn.options.read", { sessionId: snapshot.sessionId, definition: spawnDefinition }).then(result => { if (alive) setSpawnOptions(result); }).catch(error => { if (alive) setSpawnOptionsError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, [modal?.kind, spawnDefinition, client, snapshot?.sessionId, capabilities, preview]);
  const spawnStepsSupported = preview || typeof spawnOptions?.stepsAdvertised === "boolean";
  const spawnInstructionsReady = spawnMode === "steps"
    ? spawnStepsSupported && spawnSteps.length > 0 && spawnSteps.every(step => step.text.trim()) && spawnSteps.reduce((size, step) => size + step.text.length, 0) <= 65536
    : !!spawnTask.trim();
  const spawnControlsLocked = !spawnAvailable || commandBusy;
  const chooseSpawnMode = (mode: TaskAssignmentMode) => {
    if (mode === "steps" && !spawnStepsSupported) return;
    if (mode === "steps" && spawnSteps.length === 1 && !spawnSteps[0]!.text.trim() && spawnTask.trim()) {
      setSpawnSteps([{ ...spawnSteps[0]!, text: spawnTask }]);
    }
    setSpawnMode(mode);
  };
  const chatRuntimeConnected = viewingLive && (runtimeConnected ?? connOnline);
  const chatCanSend = (canSend ?? false) && viewingLive && !preview;
  const limited = runtime?.classification === "limited-system";
  const connKind =
    runtimeStatus === "unavailable" || runtimeStatus === "disconnected"
      ? "offline"
      : runtimeStatus === "connecting"
        ? "reconnecting"
        : resyncRequired
          ? "resync"
          : "online";

  const mapped = useMemo(() => {
    if (preview) {
      const fixture = buildPreviewHub(undefined, zh);
      return {
        preview: true,
        roster: fixture.agents.map(fromPreviewAgent),
        jobs: fixture.jobs.map(fromPreviewJob),
        jobAgents: fixture.jobAgents as ReadonlyArray<{ id: string; parentId?: string }>,
        mainName: fixture.main.name,
        mainStatus: fixture.main.statusText,
        mainTask: fixture.main.task,
        mainMeta: `${fixture.main.model} · ${fmtDur(fixture.main.durationMs)} · ctx ${fixture.main.contextPct}%`,
        runtimeLabel: fixture.runtimeLabel,
      };
    }
    const source = agents !== undefined ? agents : (snapshot?.agents ?? []);
    if (source.length === 0) {
      return {
        preview: false,
        roster: [],
        jobs: viewingLive ? (snapshot?.jobs ?? []).map(toHubJob) : [],
        jobAgents: (viewingLive ? (snapshot?.jobAgents ?? []) : []) as ReadonlyArray<{ id: string; parentId?: string }>,
        mainName: zh ? "主对话" : "Main conversation",
        mainStatus:
          viewingLive && snapshot?.isStreaming
            ? "Streaming"
            : viewingLive
              ? (snapshot?.activeMode ?? "idle")
              : "archived",
        mainTask:
          viewingLive && snapshot
            ? `session ${snapshot.sessionId}`
            : parentSessionId
              ? `session ${parentSessionId}`
              : (zh ? "等待 Runtime snapshot" : "Waiting for Runtime snapshot"),
        mainMeta:
          viewingLive && snapshot
            ? `${snapshot.activeMode} · pending ${snapshot.pendingMessages}`
            : parentSessionId
              ? `session ${parentSessionId}`
              : "usage —",
        runtimeLabel: undefined as string | undefined,
      };
    }
    const childMap = new Map<string, string[]>();
    for (const agent of source) {
      if (!agent.parentAgentId) continue;
      const list = childMap.get(agent.parentAgentId) ?? [];
      list.push(agent.agentId);
      childMap.set(agent.parentAgentId, list);
    }
    const all = source.map((agent) =>
      toHubAgent(agent, childMap.get(agent.agentId) ?? []),
    );
    const main = all.find((agent) => agent.kind === "main");
    const roster = all.filter((agent) => agent.kind !== "main");
    const telemetry = snapshot?.telemetry;
    const liveHeader = viewingLive && snapshot !== undefined;
    const mainMeta =
      liveHeader && telemetry
        ? `${snapshot.activeMode ?? "idle"} · ${fmtNum(telemetry.tokens.total)} tok · ${fmtCost(telemetry.tokens.cost)} · ctx ${telemetry.context ? `${Math.round(telemetry.context.percent)}%` : "—"}`
        : liveHeader
          ? `${snapshot.activeMode} · pending ${snapshot.pendingMessages} · agents ${roster.length}`
          : parentSessionId
            ? `session ${parentSessionId} · agents ${roster.length}`
            : "usage —";
    return {
      preview: false,
      roster,
      jobs: viewingLive ? (snapshot?.jobs ?? []).map(toHubJob) : [],
      jobAgents: (viewingLive ? (snapshot?.jobAgents ?? []) : []) as ReadonlyArray<{ id: string; parentId?: string }>,
      mainName: main?.name ?? (zh ? "主对话" : "Main conversation"),
      mainStatus:
        liveHeader && snapshot.isStreaming
          ? "Streaming"
          : liveHeader
            ? snapshot.activeMode
            : "archived",
      mainTask:
        main?.task ??
        (parentSessionId
          ? `session ${parentSessionId}`
          : liveHeader
            ? `session ${snapshot.sessionId}`
            : (zh ? "等待 Runtime snapshot" : "Waiting for Runtime snapshot")),
      mainMeta,
      runtimeLabel: undefined as string | undefined,
    };
  }, [preview, snapshot, agents, viewingLive, parentSessionId, zh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mapped.roster;
    return mapped.roster.filter((agent) =>
      `${agent.name} ${agent.id} ${agent.task} ${agent.kind} ${agent.modelRole ?? ""} ${agent.resolvedModel ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }, [mapped.roster, query]);

  const selectedAgent = mapped.roster.find((agent) => agent.id === selected);
  const caps = capsFor(
    selectedAgent,
    connOnline,
    capabilities,
    client !== undefined,
    preview,
    viewingLive,
    zh,
    marks,
  );
  const killTarget =
    modal?.kind === "kill"
      ? mapped.roster.find((agent) => agent.id === modal.agentId)
      : undefined;
  const killCaps = capsFor(
    killTarget,
    connOnline,
    capabilities,
    client !== undefined,
    preview,
    viewingLive,
    zh,
    marks,
  );

  const runCommand = useCallback(
    async <TName extends CommandName>(
      name: TName,
      input: CommandInput<TName>,
      okText: string,
    ): Promise<boolean> => {
      const c = contractFor(zhRef.current);
      if (preview) {
        if (marks) setNotice({ kind: "warn", text: c.previewWrite });
        return false;
      }
      if (!viewingLive) {
        setNotice({ kind: "warn", text: c.historicalWrite });
        return false;
      }
      if (!client) {
        setNotice({ kind: "warn", text: zhRef.current ? "无 Studio client（桌面桥未注入）" : "No Studio client (desktop bridge not injected)" });
        return false;
      }
      busyCountRef.current += 1;
      setBusyCount(busyCountRef.current);
      try {
        const handle = await client.command(name, input);
        await waitReceipt(client, handle.requestId);
        setNotice({ kind: "ok", text: okText });
        return true;
      } catch (error) {
        setNotice({ kind: "err", text: hostErrorMessage(error, zhRef.current ? "操作失败" : "Action failed") });
        return false;
      } finally {
        busyCountRef.current = Math.max(0, busyCountRef.current - 1);
        setBusyCount(busyCountRef.current);
      }
    },
    [client, marks, preview, viewingLive],
  );

  const cancelJob = useCallback(
    (job: HubJob) => {
      void runCommand(
        "job.cancel",
        { jobId: job.id, expectedGeneration: job.generation },
        zhRef.current ? `job ${job.id} 取消已提交` : `Submitted cancellation for job ${job.id}`,
      );
    },
    [runCommand],
  );

  const reviveAgent = useCallback(
    (agent: HubAgent) => {
      void runCommand(
        "agent.revive",
        { agentId: agent.id, expectedGeneration: agent.generation },
        zhRef.current ? `${agent.name} revive 已提交` : `Submitted revive for ${agent.name}`,
      );
    },
    [runCommand],
  );

  const releaseAgent = useCallback(
    (agent: HubAgent) => {
      void runCommand(
        "agent.release",
        { agentId: agent.id, expectedGeneration: agent.generation },
        zhRef.current ? `${agent.name} release 已提交` : `Submitted release for ${agent.name}`,
      );
    },
    [runCommand],
  );

  const killAgent = useCallback(
    (agent: HubAgent) => {
      void runCommand(
        "agent.kill",
        { agentId: agent.id, expectedGeneration: agent.generation },
        zhRef.current ? `${agent.name} 已结束` : `Stopped ${agent.name}`,
      );
    },
    [runCommand],
  );

  const draftSlot = useCallback(
    (id: string) => `${sessionKey}:${id}`,
    [sessionKey],
  );

  const sendDraft = useCallback(
    (agent: HubAgent) => {
      const slot = draftSlot(agent.id);
      const text = (draftsByAgent[slot] ?? "").trim();
      if (!text) return;
      void runCommand(
        "agent.send",
        {
          agentId: agent.id,
          expectedGeneration: agent.generation,
          text,
          mode: "prompt",
        },
        zhRef.current ? `消息已发送给 ${agent.name}` : `Message sent to ${agent.name}`,
      ).then((ok) => {
        if (ok) {
          setDraftsByAgent((prev) => {
            if (!(slot in prev)) return prev;
            const next = { ...prev };
            delete next[slot];
            return next;
          });
          setTranscriptRefresh((n) => n + 1);
        }
      });
    },
    [draftSlot, draftsByAgent, runCommand],
  );

  const select = useCallback(
    (id: string, opts?: { scroll?: boolean }) => {
      setSelectedBySession((prev) =>
        prev[sessionKey] === id ? prev : { ...prev, [sessionKey]: id },
      );
      setNotice(null);
      if (typeof window !== "undefined" && window.innerWidth <= 900)
        setDrawerOpen(true);
      if (opts?.scroll) {
        requestAnimationFrame(() => {
          const row = listRef.current?.querySelector(
            `[data-hub-id="${hubSelectorId(id)}"]`,
          );
          if (row && typeof row.scrollIntoView === "function") {
            row.scrollIntoView({
              block: "nearest",
              behavior: motionReduced() ? "instant" : "smooth",
            });
          }
        });
      }
    },
    [sessionKey],
  );

  useEffect(() => {
    const intent = readHubIntent();
    if (!intent) return;
    if (mapped.roster.some((agent) => agent.id === intent.agentId)) {
      if (intent.tab) setTab(intent.tab);
      if (intent.chat) setChatOpen(true);
      select(intent.agentId, { scroll: true });
      clearHubIntent();
      return;
    }
    if (mapped.preview) {
      clearHubIntent();
      return;
    }
    if (!persistedReady) return;
    if (snapshot === undefined && agents === undefined) return;
    clearHubIntent();
  }, [agents, mapped.preview, mapped.roster, persistedReady, select, snapshot]);

  const openChat = useCallback(
    (id: string) => {
      setChatOpen(true);
      select(id);
    },
    [select],
  );

  useEffect(() => {
    if (chatOpen && selectedAgent === undefined) setChatOpen(false);
  }, [chatOpen, selectedAgent]);

  const chatFace: "chat" | "detail" = chatOpen ? "chat" : "detail";
  const { incoming, outgoing, dir, live, stageRef } = useOverlappingTabs(
    chatFace,
    chatOpen ? 1 : 0,
  );
  const chatClosing = useHubChatCloseMotion(chatOpen, incoming, colsRef);
  const hubFaces: ReadonlyArray<"detail" | "chat"> =
    outgoing != null && outgoing !== incoming
      ? [outgoing, incoming]
      : [incoming];

  // Detail tabs cross like sibling panes: the later tab arrives from the right.
  const {
    incoming: paneIncoming,
    outgoing: paneOutgoing,
    dir: paneDir,
    live: paneLive,
    stageRef: paneStageRef,
  } = useOverlappingTabs(tab, Math.max(0, TABS.findIndex(([id]) => id === tab)));
  const detailPanes: ReadonlyArray<HubTab> =
    paneOutgoing != null && paneOutgoing !== paneIncoming
      ? [paneOutgoing, paneIncoming]
      : [paneIncoming];
  // The dossier head draws its divider once the body under it has scrolled.
  const [bodyScrolled, setBodyScrolled] = useState(false);
  useLayoutEffect(() => {
    const pane = paneStageRef.current?.querySelector<HTMLElement>(`[data-pane="${paneIncoming}"]`);
    setBodyScrolled((pane?.scrollTop ?? 0) > 0);
  }, [paneIncoming, paneStageRef]);
  // Another agent's dossier starts at its top.
  useLayoutEffect(() => {
    for (const pane of paneStageRef.current?.querySelectorAll<HTMLElement>("[data-pane]") ?? []) pane.scrollTop = 0;
    setBodyScrolled(false);
  }, [paneStageRef, selected]);
  const selectedParentName = selectedAgent?.parentId
    ? (mapped.roster.find((agent) => agent.id === selectedAgent.parentId)?.name ??
      (selectedAgent.parentId === "main" ? null : selectedAgent.parentId))
    : null;

  const warn = (text: string) => setNotice({ kind: "warn", text });

  // ---- Command deck: a third roster view. It shows the swarm and picks members;
  // the detail column beside it stays the one place to inspect and act.
  const deckView = view === "deck";
  const deckShown = deckView && workspaceTab === "agents";
  const deckAgents = useMemo(
    () => (preview ? getPreviewDockAgents(zh) : (agents ?? snapshot?.agents ?? [])),
    [preview, preview ? zh : false, agents, snapshot?.agents],
  );
  const deckScope = swarmScope ?? agentSwarmScope(null, workspaceId, parentSessionId, preview);
  const deckSource = connKind === "offline" ? "offline" : !viewingLive ? "history" : "live";
  // One read of the agents' messages serves the deck and the Messages tab beside it.
  const commsRosterKey = useMemo(() => rosterKeyOf(deckAgents), [deckAgents]);
  const commsShown = workspaceTab === "agents" && (deckShown || tab === "messages");
  const comms = useSwarmComms({ preview, zh, live: commsShown && (preview || deckSource === "live"), client,
    sessionId: viewingLive ? snapshot?.sessionId : undefined, rosterKey: commsRosterKey });
  const commsRows = useMemo(() => buildDeck(deckAgents, preview, zh), [deckAgents, preview, zh]);
  const [commsNow, setCommsNow] = useState(() => Date.now());
  useEffect(() => {
    if (!commsShown || tab !== "messages") return;
    setCommsNow(Date.now());
    const timer = window.setInterval(() => setCommsNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [commsShown, tab]);
  const deckRef = useRef<HTMLDivElement>(null);
  const [deckSize, setDeckSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = deckRef.current;
    if (!deckView || !node) return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width), height = Math.round(rect.height);
      setDeckSize((current) => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const Observer = node.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [deckView]);
  const inRoster = (id: string) => mapped.roster.some((agent) => agent.id === id);
  const deckEmbedding: DeckEmbedding = {
    selectedId: selected,
    // The lead is the main conversation, not a Hub member: its row has nothing to show here.
    onSelect: (id) => { if (inRoster(id)) select(id); },
    onClear: () => {
      setSelectedBySession((prev) => {
        if (!(sessionKey in prev)) return prev;
        const next = { ...prev };
        delete next[sessionKey];
        return next;
      });
      setChatOpen(false);
      setDrawerOpen(false);
    },
  };
  const deckLinks: DeckLinks = {
    onOpen: (row: DeckAgent) => {
      const agent = mapped.roster.find((item) => item.id === row.id);
      if (!agent) return;
      const rowCaps = capsFor(agent, connOnline, capabilities, client !== undefined, preview, viewingLive, zhRef.current, marks);
      if (rowCaps.open) openChat(agent.id);
      else { select(agent.id); warn(rowCaps.openWhy ?? (zhRef.current ? "已结束" : "Ended")); }
    },
    onMain: onOpenMain,
    onBtw: (row: DeckAgent) => {
      if (!inRoster(row.id)) return;
      setChatOpen(false);
      select(row.id);
      setTab("btw");
    },
    // Already in the Hub, and the deck shows no inspector of its own here.
    onHub: () => undefined,
    canLocate: () => false,
    onLocate: async () => false,
  };
  // Swapping between the cards and the deck crosses like sibling tabs: the deck sits to the left.
  const lastView = useRef(view);
  const deckSwap = useRef<"" | "fwd" | "back">("");
  if (lastView.current !== view) {
    if ((lastView.current === "deck") !== deckView) deckSwap.current = deckView ? "back" : "fwd";
    lastView.current = view;
  }
  const swapClass = deckSwap.current ? ` tab-pane-enter-${deckSwap.current}` : "";

  const agentId = selectedAgent?.id;
  const agentGeneration = selectedAgent?.generation;
  useEffect(() => {
    const req = ++transcriptReq.current;
    if (
      preview ||
      !viewingLive ||
      tab !== "transcript" ||
      agentId === undefined ||
      client === undefined
    ) {
      setTranscriptPage(null);
      setTranscriptError(null);
      return;
    }
    let cancelled = false;
    setTranscriptBusy(true);
    setTranscriptError(null);
    client
      .query("agent.transcript.read", {
        agentId: agentId as AgentId,
        limit: 50,
      })
      .then((page) => {
        if (cancelled || req !== transcriptReq.current) return;
        setTranscriptPage({
          agentId,
          generation: page.generation,
          messages: page.messages,
          ...(page.nextCursor !== undefined
            ? { nextCursor: page.nextCursor }
            : {}),
          eof: page.eof,
        });
      })
      .catch((error) => {
        if (!cancelled && req === transcriptReq.current)
          setTranscriptError(hostErrorMessage(error, zhRef.current ? "读取 transcript 失败" : "Failed to load transcript"));
      })
      .finally(() => {
        if (!cancelled && req === transcriptReq.current)
          setTranscriptBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [preview, viewingLive, tab, agentId, agentGeneration, client, transcriptRefresh]);

  const loadMoreTranscript = useCallback(() => {
    if (
      preview ||
      !viewingLive ||
      client === undefined ||
      selectedAgent === undefined ||
      transcriptPage?.nextCursor === undefined
    )
      return;
    const cursor = transcriptPage.nextCursor as OpaqueCursor;
    const agent = selectedAgent;
    const req = transcriptReq.current;
    setTranscriptBusy(true);
    client
      .query("agent.transcript.read", {
        agentId: agent.id as AgentId,
        cursor,
        limit: 50,
      })
      .then((page) => {
        if (req !== transcriptReq.current) return;
        setTranscriptPage((current) => {
          if (current === null || current.agentId !== agent.id) return current;
          const seen = new Set(current.messages.map((message) => message.id));
          const merged = [
            ...current.messages,
            ...page.messages.filter((message) => !seen.has(message.id)),
          ];
          return {
            agentId: current.agentId,
            generation: page.generation,
            messages: merged,
            ...(page.nextCursor !== undefined
              ? { nextCursor: page.nextCursor }
              : {}),
            eof: page.eof,
          };
        });
      })
      .catch((error) => {
        if (req === transcriptReq.current)
          setTranscriptError(hostErrorMessage(error, zhRef.current ? "读取 transcript 失败" : "Failed to load transcript"));
      })
      .finally(() => {
        if (req === transcriptReq.current) setTranscriptBusy(false);
      });
  }, [preview, viewingLive, client, selectedAgent, transcriptPage?.nextCursor]);

  useEffect(() => {
    if (
      modal?.kind !== "spawn" ||
      preview ||
      !viewingLive ||
      client === undefined ||
      spawnDefinitions !== null
    )
      return;
    let cancelled = false;
    client
      .query("agents.definitions.get", {})
      .then((model) => {
        if (cancelled) return;
        const agents = model.agents.map((definition) => ({
          name: definition.name,
          description: definition.description,
          ...(definition.model ? { model: definition.model } : {}),
        }));
        setSpawnDefinitions(agents);
        setSpawnDefinition((current) => current || agents[0]?.name || "");
      })
      .catch(() => {
        if (!cancelled) setSpawnDefinitions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [modal, preview, viewingLive, client, spawnDefinitions]);
  useEffect(() => {
    if (workspaceTab !== "agents" && !modal) return;
    const onKey = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !root.isConnected || root.closest("[hidden], [inert], [aria-hidden='true']")) return;
      if (document.hidden || document.visibilityState === "hidden") return;
      if (modal) {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !commandBusy &&
          busyCountRef.current === 0 &&
          !spawnLock.current
        ) {
          event.preventDefault();
          setModal(null);
        }
        return;
      }
      if (workspaceTab !== "agents") return;
      const target = event.target as HTMLElement | null;
      const inField = Boolean(
        target?.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
        ),
      );
      if (inField && event.key !== "Escape") return;
      if (document.querySelector(".modal-backdrop")) return;
      if (chatOpen) {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          setChatOpen(false);
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // The deck moves through its own crew, views and cards; the Hub keeps the shortcuts that act on the pick.
      const deck = view === "deck";
      if (deck && event.key === "Enter" && target?.closest(".ad")) return;
      const seq = linearSeq(filtered, view);
      const index = seq.findIndex((agent) => agent.id === selected);
      switch (event.key) {
        case "j":
        case "ArrowDown":
          if (deck) break;
          event.preventDefault();
          if (seq.length)
            select(
              seq[
                Math.min(
                  seq.length - 1,
                  Math.max(0, index) + (index < 0 ? 0 : 1),
                )
              ]!.id,
              { scroll: true },
            );
          break;
        case "k":
        case "ArrowUp":
          if (deck) break;
          event.preventDefault();
          if (seq.length)
            select(seq[Math.max(0, index < 0 ? 0 : index - 1)]!.id, {
              scroll: true,
            });
          break;
        case "Enter":
          if (selectedAgent) {
            event.preventDefault();
            if (caps.open) openChat(selectedAgent.id);
            else warn(caps.openWhy ?? (zhRef.current ? "已结束" : "Ended"));
          }
          break;
        case "t":
          // Flips the card list between flat and by-parent; it never swaps the deck in or out.
          if (deck) break;
          event.preventDefault();
          setView((current) => (current === "flat" ? "tree" : "flat"));
          break;
        case "r":
          if (selectedAgent) {
            event.preventDefault();
            if (commandBusy || busyCountRef.current > 0) break;
            if (caps.revive) reviveAgent(selectedAgent);
            else warn(caps.reviveWhy ?? contractFor(zhRef.current).revive);
          }
          break;
        case "x":
          if (selectedAgent) {
            event.preventDefault();
            if (commandBusy || busyCountRef.current > 0) break;
            if (caps.kill)
              setModal({ kind: "kill", agentId: selectedAgent.id });
            else warn(caps.killWhy ?? contractFor(zhRef.current).kill);
          }
          break;
        case "Escape":
          if (event.defaultPrevented) break;
          if (drawerOpen) setDrawerOpen(false);
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [
    caps.kill,
    caps.killWhy,
    caps.open,
    caps.openWhy,
    caps.revive,
    caps.reviveWhy,
    chatOpen,
    commandBusy,
    drawerOpen,
    filtered,
    modal,
    openChat,
    reviveAgent,
    select,
    selected,
    selectedAgent,
    view,
    workspaceTab,
  ]);

  const counts = useMemo(() => {
    const next: Partial<Record<HubStatus, number>> = {};
    for (const agent of mapped.roster)
      next[agent.status] = (next[agent.status] ?? 0) + 1;
    return next;
  }, [mapped.roster]);

  const runtimeLabel =
    mapped.runtimeLabel ??
    (limited ? "Limited Runtime" : (runtime?.classification ?? "OMP Runtime"));
  const mainName =
    mapped.mainName === "主对话" && !zh ? "Main conversation" : mapped.mainName;
  const mainTask = mapped.mainTask;
  const mainStatus = hubWord(mapped.mainStatus, zh);
  const mainMeta = mapped.mainMeta;
  // The deck has its own search, so its usage line covers the whole roster.
  const usageRows = deckView ? mapped.roster : filtered;
  const usage = useMemo(() => {
    const metrics = usageRows
      .map((agent) => agent.metrics)
      .filter((item): item is PreviewMetrics => Boolean(item));
    if (!metrics.length) return `Usage — · 0/${usageRows.length} measured`;
    const seed = {
      cost: 0,
      durationMs: 0,
      requests: 0,
      tools: 0,
      tokens: 0,
      timed: 0,
    };
    const total = metrics.reduce(
      (sum, item) => ({
        cost: sum.cost + item.cost,
        durationMs: sum.durationMs + item.durationMs,
        requests: sum.requests + item.requests,
        tools: sum.tools + item.tools,
        tokens: sum.tokens + item.tokens,
        timed:
          sum.timed +
          (item.durationKind && item.durationKind !== "unknown" ? 1 : 0),
      }),
      seed,
    );
    return `${fmtCost(total.cost)} · ${fmtDur(total.durationMs)} active agent time · ${total.requests} req · ${total.tools} tools · ${fmtNum(total.tokens)} tok · ${total.timed}/${metrics.length} timed · ${metrics.length}/${usageRows.length} measured`;
  }, [usageRows]);

  const renderList = () => {
    if (!filtered.length) {
      if (query.trim()) {
        return (
          <div className="hub-empty-list">
            <Icon name="search" />
            <b>{zh ? "没有匹配的 Agent" : "No matching agents"}</b>
            <span>{zh ? "试试其他 id、名称、任务或模型关键字。" : "Try another id, name, task, or model keyword."}</span>
          </div>
        );
      }
      return (
        <div className="hub-empty-list">
          <Icon name="bot" />
          <b>No agents in this session</b>
          <span>
            Finished, parked, and killed subagents remain with the session that
            created them.
          </span>
          <span className="tiny">
            Resume that session with{" "}
            <span className="mono">omp --continue</span>, or spawn a task here.
          </span>
          <button
            className="btn small primary"
            type="button"
            disabled={!spawnAvailable || commandBusy}
            data-tip={spawnTip}
            onClick={() => {
              setNotice(null);
              setModal({ kind: "spawn" });
            }}
          >
            <Icon name="plus" extra="sm" />
            {zh ? "创建代理" : "New Agent"}
          </button>
        </div>
      );
    }
    if (view === "tree") {
      const tree = treeGroups(filtered);
      const childIds = new Set(
        tree.groups.flatMap((group) => group.kids.map((kid) => kid.id)),
      );
      return (
        <>
          {tree.groups.map((group) => (
            <TreeGroup
              key={group.head.id}
              head={group.head}
              kids={group.kids}
              nodes={group.nodes}
              selected={selected}
              now={now}
              onSelect={select}
            />
          ))}
          {tree.orphans.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              selected={selected === agent.id}
              kids={agent.children.filter((id) => !childIds.has(id)).length}
              now={now}
              onSelect={select}
            />
          ))}
          <KbdHint />
        </>
      );
    }
    return (
      <>
        {sortByCreation(filtered).map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            selected={selected === agent.id}
            kids={agent.children.length}
            now={now}
            onSelect={select}
          />
        ))}
        <KbdHint />
      </>
    );
  };
  const renderOverview = (agent: HubAgent) => {
    const taskSteps = preview ? previewTaskStepsForAgent(agent.id, zh) : (agents ?? snapshot?.agents ?? []).find(row => row.agentId === agent.id)?.taskSteps;
    return (
      <HubAgentOverview
        zh={zh}
        agent={agent}
        roster={mapped.roster}
        now={now}
        select={select}
        onOpenMain={onOpenMain}
        onJobs={() => setTab("jobs")}
        steps={taskSteps ? <TaskStepsView key={agent.id} state={taskSteps} zh={zh} /> : null}
        models={
          <AgentModelDetails
            client={client}
            sessionId={snapshot?.sessionId}
            agentId={agent.id}
            available={viewingLive && connOnline}
            capabilities={capabilities}
            running={agent.status === "running"}
            previewModel={agent.resolvedModel}
            previewSaved={!agent.hasLiveSession}
          />
        }
      />
    );
  };
  const renderJobRow = (row: JobTreeRow<HubJob>, agent?: HubAgent) => <HubJobRow key={row.job.id} selectedJobId={selectedJobId} setSelectedJobId={setSelectedJobId} zh={zh} preview={preview} viewingLive={viewingLive} commandBusy={commandBusy} connOnline={connOnline} client={client} capabilities={capabilities} cancelJob={cancelJob} parentSessionId={parentSessionId} snapshot={snapshot} resyncRequired={resyncRequired} row={row} agent={agent} />;

  const renderJobs = (agent?: HubAgent) => {
    // Subagent jobs nest under the task job that runs the subagent; an agent's
    // own tab lists only the jobs it owns (with what nests under them).
    const rows = agent
      ? agentJobTree(mapped.jobs, mapped.jobAgents, agent.id)
      : buildJobTree(mapped.jobs, mapped.jobAgents);
    return (
      <>
        <div className="hub-cap-note" style={{ marginBottom: "var(--sp-8)" }}>
          <Icon name="lock" extra="sm" />
          {missingCap(capabilities, "job.cancel")
            ? contract.cancel
            : zh
              ? "取消走 runtime 确认门；运行中的 job 才可取消（owner-scoped）"
              : "Cancellation goes through the runtime confirmation gate; only running jobs can be cancelled (owner-scoped)"}
        </div>
        {rows.length ? (
          <div className="hub-job-tree">
            {rows.map((row) => renderJobRow(row, agent))}
          </div>
        ) : (
          <EmptyBlock
            icon="terminal"
            detail={agent ? (zh ? "没有该 Agent 的 job" : "This agent has no jobs") : zh ? "没有 job" : "No jobs"}
          />
        )}
      </>
    );
  };

  const renderDetailBody = (agent: HubAgent, pane: HubTab) => {
    if (pane === "btw") return <AgentBtwPane key={`${parentSessionId ?? snapshot?.sessionId}:${agent.id}`} showTarget={false} client={client} sessionId={parentSessionId ?? snapshot?.sessionId} agentId={agent.id} available={connOnline && viewingLive && !resyncRequired && agent.kind !== "main" && agent.hasLiveSession && !missingCap(capabilities, "agent.btw.read")} />;
    if (pane === "transcript") {
      if (preview) {
        return (
          <>
            <div className="hub-transcript" id="hubTranscript">
              <EmptyBlock
                icon="message"
                detail={
                  agent.hasTranscript
                    ? marks
                      ? (zh ? "预览模式不读取真实 transcript" : "Preview mode does not read real transcripts")
                      : (zh ? "点击「打开对话」查看完整对话记录。" : "Click Open conversation to view the full transcript.")
                    : (zh ? "暂无消息。" : "No messages yet.")
                }
              />
            </div>
            {marks ? (
              <div className="hub-ro-banner">
                <Icon name="lock" extra="sm" />
                <span>{zh ? "预览模式不调用 Host 写操作" : "Preview mode does not invoke Host write operations"}</span>
              </div>
            ) : null}
          </>
        );
      }
      if (!viewingLive) {
        return (
          <>
            <div className="hub-transcript" id="hubTranscript">
              <EmptyBlock
                icon="message"
                detail={zh ? "历史会话请用「打开」查看归档对话，不读取 live transcript。" : "For historical sessions, click Open to view archived conversations; live transcripts are unavailable."}
              />
            </div>
            <div className="hub-ro-banner">
              <Icon name="lock" extra="sm" />
              <span>{contract.historicalWrite}</span>
            </div>
          </>
        );
      }
      const page = transcriptPage?.agentId === agent.id ? transcriptPage : null;
      const currentDraft = draftsByAgent[draftSlot(agent.id)] ?? "";
      return (
        <>
          <div className="hub-transcript" id="hubTranscript">
            {transcriptBusy && !page ? (
              <EmptyBlock icon="message" detail={zh ? "读取 transcript…" : "Loading transcript…"} />
            ) : null}
            {transcriptError ? (
              <EmptyBlock icon="alert" detail={transcriptError} />
            ) : null}
            {!transcriptBusy && !transcriptError && !page ? (
              <EmptyBlock
                icon="message"
                detail={
                  agent.hasTranscript ? contract.transcript : (zh ? "暂无消息。" : "No messages yet.")
                }
              />
            ) : null}
            {page
              ? page.messages.map((message) => (
                  <div
                    className={`hub-tr-msg ${message.role}`}
                    key={message.id}
                  >
                    <div className="tr-head">
                      <span className="tr-role">{message.role}</span>
                      <span className="mono tiny muted">
                        {fmtClock(message.ts)}
                      </span>
                    </div>
                    <div className="tr-body">{message.text}</div>
                  </div>
                ))
              : null}
            {page && page.nextCursor !== undefined ? (
              <button
                className="btn small outline"
                type="button"
                disabled={transcriptBusy}
                style={{ margin: "var(--sp-8) auto" }}
                onClick={loadMoreTranscript}
              >
                {zh ? "加载更早消息" : "Load older messages"}
              </button>
            ) : null}
          </div>
          <div className="hub-send">
            <input
              className="input"
              type="text"
              placeholder={
                caps.chat
                  ? (zh ? `发消息给 ${agent.name}（prompt）…` : `Message ${agent.name} (prompt)…`)
                  : (caps.chatWhy ?? contract.chat)
              }
              aria-label={zh ? "发送消息" : "Send message"}
              value={currentDraft}
              disabled={!caps.chat || commandBusy}
              onChange={(event) => {
                const value = event.target.value;
                const slot = draftSlot(agent.id);
                setDraftsByAgent((prev) => ({ ...prev, [slot]: value }));
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur();
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  currentDraft.trim()
                ) {
                  event.preventDefault();
                  sendDraft(agent);
                }
              }}
            />
            <button
              className="btn small primary"
              type="button"
              disabled={!caps.chat || commandBusy || !currentDraft.trim()}
              data-tip={caps.chatWhy ?? undefined}
              onClick={() => sendDraft(agent)}
            >
              <Icon name="message" extra="sm" />
              {zh ? "发送" : "Send"}
            </button>
          </div>
          {agent.status === "parked" ? (
            <div className="hub-cap-note">
              <Icon name="clock" extra="sm" />
              {agent.isolated || agent.canRevive === false
                ? (zh ? "仅保留记录和产物，不可自动 revive" : "Records and artifacts only; automatic revive is unavailable")
                : (zh ? "parked agent：发送将自动 revive（outcome=revived）" : "Parked agent: sending automatically revives it (outcome=revived)")}
            </div>
          ) : null}
        </>
      );
    }
    if (pane === "jobs") return renderJobs(agent);
    if (pane === "messages") {
      return (
        <div className="hub-comms">
          <CommsView comms={comms} rows={commsRows} now={commsNow} replay={null} query="" selectedId={null} only={agent.id}
            onSelect={(id) => { if (id !== agent.id && mapped.roster.some((row) => row.id === id)) select(id, { scroll: true }); }} d={deckWords} />
        </div>
      );
    }
    return renderOverview(agent);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") searchRef.current?.blur();
  };

  const composerAgents = preview
    ? hubComposerAgents(mapped.roster)
    : agents !== undefined
      ? agents
      : (snapshot?.agents ?? []);

  return (
    <div
      className={`hub-page${deckShown ? " is-deck" : ""}${chatOpen && workspaceTab === "agents" ? " is-chat-preview" : ""}${chatClosing && workspaceTab === "agents" ? " is-chat-closing" : ""}`}
      id="hubRoot"
      ref={rootRef}
    >
      <WorkspaceTabs<"agents" | "jobs" | "services">
        id="hub-workspace"
        label={zh ? "代理工作区" : "Agent workspace"}
        value={workspaceTab}
        onChange={setWorkspaceTab}
        items={[
          { id: "agents", label: zh ? "代理" : "Agents", icon: "bot" },
          {
            id: "jobs",
            label: zh ? "后台任务" : "Background jobs",
            icon: "terminal",
          },
          { id: "services", label: zh ? "服务" : "Services", icon: "server" },
        ]}
      />
      {!modal && notice && (!preview || marks) ? (
        <div
          className={`hub-notice ${notice.kind}`}
          role={notice.kind === "ok" ? "status" : "alert"}
        >
          <Icon name={notice.kind === "ok" ? "check" : "alert"} extra="sm" />
          <span>{notice.text}</span>
        </div>
      ) : null}
      <WorkspacePanel
        id="hub-workspace"
        name="services"
        active={workspaceTab === "services"}
      >
        <ServicesPane
          standalone
          visible={workspaceTab === "services"}
          key={
            (workspaceId ?? "") +
            ":" +
            (parentSessionId ?? snapshot?.sessionId ?? "") +
            ":" +
            preview
          }
          client={client}
          workspaceId={workspaceId}
          sessionId={parentSessionId ?? snapshot?.sessionId}
          available={connOnline && viewingLive && !resyncRequired}
          capabilities={capabilities}
        />
      </WorkspacePanel>
      <WorkspacePanel
        id="hub-workspace"
        name="jobs"
        active={workspaceTab === "jobs"}
      >
        {renderJobs()}
      </WorkspacePanel>
      <WorkspacePanel
        id="hub-workspace"
        name="agents"
        active={workspaceTab === "agents"}
      >
        {connKind === "offline" ? (
          <RuntimeLossBanner
            {...(runtime === undefined ? {} : { runtime })}
            {...(client === undefined ? {} : { client })}
            preview={preview}
            variant="hub"
            {...(onOpenDiagnostics === undefined ? {} : { onOpenDiagnostics })}
          />
        ) : null}
        {connKind === "reconnecting" ? (
          <div className="hub-conn amber">
            <span className="spinner" />
            <b>{zh ? "正在重连" : "Reconnecting"}</b>
            <span className="hc-detail">
              {zh
                ? "与 runtime 的连接中断，正在重试… roster 为最后一次同步的快照。"
                : "Connection to runtime lost, retrying… Roster shows the last synced snapshot."}
            </span>
          </div>
        ) : null}
        {connKind === "resync" ? (
          <div className="hub-conn blue">
            <span className="spinner" />
            <b>{zh ? "状态回源中" : "Resyncing state"}</b>
            <span className="hc-detail">
              {zh
                ? "正在恢复最新 Runtime 状态，敏感操作已暂停。"
                : "Restoring latest runtime state; sensitive actions are paused."}
            </span>
          </div>
        ) : null}

        <div className="hub-main">
          <span className="hm-ic">
            <Icon name="message" />
          </span>
          <div className="hm-main">
            <div className="hm-title">
              {mainName}
              <span className="chip blue xs">{mainStatus}</span>
            </div>
            <div className="hm-sub">
              <span className="hm-task ellipsis">{mainTask}</span>
              <span className="hm-meta mono">{mainMeta}</span>
              <span className="hm-meta mono hm-conn">
                {runtimeLabel === "Full Parity Runtime"
                  ? zh
                    ? "托管 Runtime"
                    : "Managed Runtime"
                  : runtimeLabel}
                <span className={`hm-dot${connOnline ? " on" : ""}`} />
                {connOnline
                  ? zh
                    ? "已连接"
                    : "Connected"
                  : zh
                    ? "未连接"
                    : "Disconnected"}{" "}
                · {zh ? "更新于" : "Updated"} {fmtClock(now)}
              </span>
            </div>
          </div>
          <div className="hm-actions">
            <button
              className="btn small primary"
              type="button"
              onClick={onOpenMain}
            >
              <Icon name="external" extra="sm" />
              {zh ? "打开主对话" : "Open main conversation"}
            </button>
          </div>
        </div>

        <div className="hub-roster-head">
          <div className="seg hub-view-seg" role="group" aria-label={zh ? "Roster 视图" : "Roster view"}>
            <button
              type="button"
              className={view === "deck" ? "active" : undefined}
              aria-pressed={view === "deck"}
              data-tip={zh ? "编队、时间线、星图与通讯；详情仍在右侧" : "Crew, timeline, orbit and comms; details stay on the right"}
              onClick={() => setView("deck")}
            >
              <Icon name="formation" extra="sm" />
              {zh ? "指挥台" : "Deck"}
            </button>
            <button
              type="button"
              className={view === "flat" ? "active" : undefined}
              aria-pressed={view === "flat"}
              onClick={() => setView("flat")}
            >
              {zh ? "平铺" : "Flat"}
            </button>
            <button
              type="button"
              className={view === "tree" ? "active" : undefined}
              aria-pressed={view === "tree"}
              onClick={() => setView("tree")}
            >
              {zh ? "按父代理" : "By parent"}
            </button>
          </div>
          {deckView ? null : <>
          <div className="hub-status-counts">
            {(["running", "idle", "parked", "aborted", "released"] as const)
              .filter((key) => counts[key])
              .map((key) => (
                <span className="sc-item" key={key}>
                  <span className={`dot ${STATUS_DOT[key]}`} />
                  {counts[key]} {hubWord(STATUS_LABEL[key], zh)}
                </span>
              ))}
          </div>
          <span className="spacer" />
          <input
            ref={searchRef}
            className="input hub-search"
            type="search"
            placeholder={
              zh ? "搜索名称 / 任务 / 模型…" : "Search name / task / model…"
            }
            aria-label={zh ? "搜索 Agent" : "Search agents"}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
          </>}
        </div>

        {usageRows.length ? (
          <div className="hub-usage">
            <span>{usage}</span>
            <span className="spacer" />
            <button
              className="btn small primary"
              type="button"
              disabled={!spawnAvailable || commandBusy}
              data-tip={spawnTip}
              onClick={() => {
                setNotice(null);
                setModal({ kind: "spawn" });
              }}
            >
              <Icon name="plus" extra="sm" />
              {zh ? "创建代理" : "New Agent"}
            </button>
          </div>
        ) : null}

        <div
          className={`hub-cols${deckView ? " is-deck" : ""}${chatOpen ? " is-chat-preview" : ""}`}
          ref={colsRef}
        >
          {deckView ? (
            <div className={`hub-deck-col${swapClass}`} key="deck" ref={deckRef}>
              <AgentDeck
                instanceKey={`${deckScope}|hub`}
                scope={deckScope}
                agents={deckAgents}
                ready={preview || persistedReady}
                source={deckSource}
                visible={deckShown}
                width={deckSize.width}
                height={deckSize.height}
                region="hub"
                openedIds={[]}
                links={deckLinks}
                commandContext={{ client, capabilities, preview, marks, viewingLive, online: connOnline }}
                comms={comms}
                embedded={deckEmbedding}
              />
            </div>
          ) : (
            <div
              className={`hub-list${view === "tree" ? " tree" : ""}${swapClass}`}
              key="list"
              id="hubList"
              ref={listRef}
              role="listbox"
              aria-label={zh ? "子 Agent 列表" : "Subagent list"}
            >
              {renderList()}
            </div>
          )}
          {selectedAgent ? (
            <div
              className={`hub-detail${drawerOpen || !narrow ? " open" : ""}${chatOpen || chatClosing ? " is-chat" : ""}`}
              id="hubDetail"
            >
              <div className="hub-face-stage" ref={stageRef}>
                {hubFaces.map((face) => {
                  const role = tabPaneRole(face, incoming, outgoing, live);
                  return (
                    <div
                      key={face}
                      className={hubFaceClass(role, dir)}
                      data-tab-pane={face}
                      data-hub-face={face}
                      {...(role === "leave"
                        ? { "aria-hidden": true, inert: true }
                        : {})}
                    >
                      {face === "chat" ? (
                        <>
                          <div className="hub-chat-bar">
                            <button
                              className="btn small ghost"
                              type="button"
                              onClick={() => setChatOpen(false)}
                            >
                              <Icon name="arrow-l" extra="sm" />
                              {zh ? "返回" : "Back"}
                            </button>
                            <span className="hub-chat-who" key={selectedAgent.id}>
                              <HubSigil agent={selectedAgent} size={22} />
                              <b title={selectedAgent.name}>{selectedAgent.name}</b>
                              <HubStatusPill agent={selectedAgent} zh={zh} />
                            </span>
                          </div>
                          <SubagentConversationPane
                            target={hubChatTarget(selectedAgent)}
                            preview={preview}
                            client={preview ? null : (client ?? null)}
                            sendClient={preview ? null : (client ?? null)}
                            agents={composerAgents}
                            canSend={chatCanSend}
                            runtimeConnected={chatRuntimeConnected}
                            {...(parentSessionId === undefined
                              ? {}
                              : { parentSessionId })}
                            {...(liveSessionId === undefined
                              ? {}
                              : { liveSessionId })}
                            {...(pendingInteraction === undefined
                              ? {}
                              : { pendingInteraction })}
                            composerId="hubAgentComposer"
                            autoFocusComposer
                            {...(preview ? { previewComposer: true } : {})}
                            {...(preview || workspaceId === undefined
                              ? {}
                              : { workspaceId })}
                            {...(preview || loadMentions === undefined
                              ? {}
                              : { loadMentions })}
                          />
                        </>
                      ) : (
                        <>
                          <HubDossierHead
                            agent={selectedAgent}
                            parentName={selectedParentName}
                            now={now}
                            zh={zh}
                            caps={caps}
                            busy={commandBusy}
                            scrolled={bodyScrolled}
                            onBack={() => setDrawerOpen(false)}
                            onParent={() =>
                              selectedAgent.parentId && inRoster(selectedAgent.parentId)
                                ? select(selectedAgent.parentId, { scroll: true })
                                : onOpenMain()
                            }
                            onOpen={() => openChat(selectedAgent.id)}
                            onRevive={() => reviveAgent(selectedAgent)}
                            onKill={() => {
                              if (!caps.kill) warn(caps.killWhy ?? contract.kill);
                              else setModal({ kind: "kill", agentId: selectedAgent.id });
                            }}
                            onRelease={() => releaseAgent(selectedAgent)}
                          />
                          <div className="hub-detail-tabs">
                            <SlidingTabs id="hubTabs" ariaLabel={zh ? "Agent 详情" : "Agent details"} value={tab} orientation="horizontal" className="tabs"
                              items={TABS.map(([id, label, icon]) => {
                                const count = id === "jobs" ? selectedAgent.activeJobIds.length : id === "messages" ? selectedAgent.unread : 0;
                                return {
                                  id,
                                  label: hubWord(label, zh),
                                  icon,
                                  buttonId: `hub-tab-${id}`,
                                  panelId: `hub-pane-${id}`,
                                  ...(count > 0 ? { badge: <span className="hub-tab-badge">{count}</span> } : {}),
                                };
                              })}
                              onChange={id => { setTab(id); setNotice(null); }} />
                          </div>
                          <div className="hub-detail-body" ref={paneStageRef}>
                            {detailPanes.map((pane) => {
                              const paneRole = tabPaneRole(pane, paneIncoming, paneOutgoing, paneLive);
                              return (
                                <div
                                  key={pane}
                                  className={`hub-pane${paneRole ? ` tab-pane-${paneRole}-${paneDir}` : ""}`}
                                  data-tab-pane={pane}
                                  data-pane={pane}
                                  id={`hub-pane-${pane}`}
                                  role="tabpanel"
                                  aria-labelledby={`hub-tab-${pane}`}
                                  onScroll={(event) => {
                                    if (pane === paneIncoming) setBodyScrolled(event.currentTarget.scrollTop > 0);
                                  }}
                                  {...(paneRole === "leave" ? { "aria-hidden": true, inert: true } : {})}
                                >
                                  <div className="hub-pane-inner" key={selectedAgent.id}>
                                    {renderDetailBody(selectedAgent, pane)}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="hub-detail hub-detail-placeholder">
              <div className="hub-empty-list" style={{ border: "none" }}>
                <Icon name="cursor" />
                <b>{zh ? "未选择 Agent" : "No agent selected"}</b>
                <span>{deckView
                  ? (zh ? "在左侧指挥台的编队、时间线或星图中选择一个子 Agent。" : "Pick a subagent in the deck's crew, timeline or orbit.")
                  : (zh ? "从左侧列表选择一个子 Agent 查看详情。" : "Select a subagent from the list to view details.")}</span>
              </div>
            </div>
          )}
        </div>

        <ModelDelegationList
          client={client ?? null}
          preview={preview}
          {...(parentSessionId ? { sessionId: parentSessionId } : {})}
        />
      </WorkspacePanel>
      {modal ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => {
            if (!commandBusy && !spawnLock.current) setModal(null);
          }}
        >
          <div
            className={`modal hub-modal${modal.kind === "spawn" ? " is-spawn" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.kind === "spawn"
                ? zh
                  ? "创建代理"
                  : "New Agent"
                : zh
                  ? "结束任务"
                  : "End task"
            }
            onMouseDown={(event) => event.stopPropagation()}
          >
            {modal.kind === "spawn" ? (
              <>
                <div className="modal-head">
                  <b>{zh ? "创建代理" : "New Agent"}</b>
                  <button
                    className="icon-btn small"
                    type="button"
                    aria-label={zh ? "关闭" : "Close"}
                    data-tip={zh ? "关闭" : "Close"}
                    onClick={() => setModal(null)}
                  >
                    <Icon name="x" extra="sm" />
                  </button>
                </div>
                <div className="modal-body">
                  {notice && notice.kind !== "ok" ? (
                    <div className={`hub-notice ${notice.kind}`} role="alert">
                      {notice.text}
                    </div>
                  ) : null}
                  <div className="hub-na-grid">
                    <div className="field">
                      <label className="tiny muted" htmlFor="naRole">{zh ? "代理定义" : "Agent definition"}</label>
                      <AppSelect className="select" id="naRole" value={spawnDefinition} onChange={event => setSpawnDefinition(event.target.value)} disabled={spawnControlsLocked || !spawnDefinitions?.length}>
                        {spawnDefinitions === null ? <option value="">{zh ? "读取定义中…" : "Loading definitions…"}</option> : spawnDefinitions.length === 0 ? <option value="">{zh ? "暂无可用代理定义" : "No agent definitions available"}</option>
                          : spawnDefinitions.map(definition => <option key={definition.name} value={definition.name}>{definition.name}{definition.description ? ` — ${definition.description.slice(0, 60)}` : ""}</option>)}
                      </AppSelect>
                    </div>
                    <TaskAssignmentEditor mode={spawnMode} onModeChange={chooseSpawnMode} assignment={spawnTask} onAssignmentChange={setSpawnTask} steps={spawnSteps} onStepsChange={setSpawnSteps} disabled={spawnControlsLocked} stepsSupported={spawnStepsSupported} zh={zh}
                      {...(spawnOptions === undefined ? {} : { stepsAdvertised: spawnOptions.stepsAdvertised })} />
                    {spawnOptionsError ? <p className="small" role="alert">{spawnOptionsError}</p> : null}
                    <details className="task-spawn-options">
                      <summary><Icon name="settings" extra="sm" />{zh ? "任务级配置" : "Task-level configuration"}<span className="muted">{zh ? "· 模型、思考强度与边界" : "· model, effort and constraints"}</span></summary>
                      <div className="hub-na-grid">
                        <div className="hub-na-row">
                          <div className="field"><label className="tiny muted" htmlFor="naModel">{zh ? "单次任务模型" : "Model for this task"}</label>
                            <AppSelect id="naModel" className="select" value={spawnModel} disabled={spawnControlsLocked || !spawnOptions?.modelSelection} onChange={event => setSpawnModel(event.target.value)}>
                              <option value="">{zh ? "使用代理配置" : "Use agent configuration"}</option>{spawnOptions?.models.map(model => <option key={model.selector} value={model.selector}>{model.name} · {model.selector}</option>)}
                            </AppSelect>
                          </div>
                          <div className="field"><label className="tiny muted" htmlFor="naEffort">{zh ? "本次思考强度" : "Thinking effort for this run"}</label>
                            <AppSelect className="select" id="naEffort" value={spawnEffort} onChange={event => setSpawnEffort(event.target.value)} disabled={spawnControlsLocked || !spawnOptions?.effortSelection}>
                              <option value="">{zh ? "继承代理定义" : "Inherit agent definition"}</option><option value="lo">{zh ? "轻量" : "Low"}</option><option value="med">{zh ? "标准" : "Medium"}</option><option value="hi">{zh ? "深入" : "High"}</option>
                            </AppSelect>
                          </div>
                        </div>
                        <p className="tiny muted">{spawnOptions?.modelSelection ? (zh ? "只显示原生策略授权的精确模型；所有步骤沿用本次任务配置。" : "Only exact models granted by native policy; every step shares this task's configuration.") : (zh ? "模型与备用链继承代理配置；单次模型选择需由原生设置授权。" : "Models and fallbacks come from the agent; per-call selection requires native authorization.")}{spawnOptions ? ` · max effort: ${spawnOptions.maxEffort}` : ""}</p>
                        <div className="field"><label className="tiny muted" htmlFor="naSolutionSpace">{zh ? "解题范围" : "Solution space"}</label>
                          <textarea className="input" id="naSolutionSpace" rows={3} maxLength={65536} value={spawnSolutionSpace} onChange={event => setSpawnSolutionSpace(event.target.value)} placeholder={zh ? "允许探索的方案、限制与边界" : "Allowed approaches and constraints"} disabled={spawnControlsLocked} />
                        </div>
                        <div className="agent-spawn-config"><strong className="tiny muted">{zh ? "代理模型配置" : "Agent model configuration"}</strong><p className="tiny muted">{zh ? "可在模型工作区的代理页编辑配置与备用链。" : "Edit the configuration and fallback chain in Models → Agents."}</p>
                          <code>{spawnDefinitions?.find(item => item.name === spawnDefinition)?.model?.join(" → ") || (zh ? "使用原生角色与代理模型配置" : "Use native role and agent model settings")}</code>
                        </div>
                      </div>
                    </details>
                    {preview && marks ? <p className="tiny muted">{zh ? "演示：只预览任务配置，不会创建真实代理或调用模型。" : "Demo: preview task configuration without creating an agent or calling a model."}</p> : null}
                  </div>
                </div>
                <div className="modal-foot">
                  <button
                    className="btn outline"
                    type="button"
                    onClick={() => setModal(null)}
                  >
                    {zh ? "取消" : "Cancel"}
                  </button>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={
                      !spawnAvailable ||
                      commandBusy ||
                      !spawnInstructionsReady ||
                      !spawnDefinition
                    }
                    data-tip={spawnTip}
                    onClick={() => {
                      if (spawnLock.current || !spawnAvailable || !spawnInstructionsReady) return;
                      const definition = spawnDefinition.trim();
                      if (
                        !(spawnDefinitions ?? []).some(
                          (item) => item.name === definition,
                        )
                      ) {
                        setNotice({
                          kind: "warn",
                          text: zh
                            ? "请选择可用的代理定义"
                            : "Choose an available agent definition",
                        });
                        return;
                      }
                      if (preview) {
                        if (marks) setNotice({
                          kind: "ok",
                          text: zh
                            ? `演示任务已配置：${definition} · 使用代理配置${spawnEffort ? " · " + spawnEffort : ""}。未执行真实任务。`
                            : `Demo task configured: ${definition}. No real task was executed.`,
                        });
                        setModal(null);
                        return;
                      }
                      const epoch = spawnEpoch.current;
                      spawnLock.current = true;
                      void runCommand(
                        "agent.spawn",
                        {
                          definition,
                          ...(spawnMode === "steps" ? { steps: spawnSteps.map(step => step.text) } : { assignment: spawnTask }),
                          ...(spawnOptions?.modelSelection && spawnModel ? { model: [spawnModel] } : {}),
                          ...(spawnSolutionSpace.trim() ? { solutionSpace: spawnSolutionSpace.trim() } : {}),
                          async: true,
                          ...(spawnOptions?.effortSelection && spawnEffort ? { effort: spawnEffort } : {}),
                        },
                        zh ? "代理任务已提交" : "Agent task submitted",
                      )
                        .then((ok) => {
                          if (ok && epoch === spawnEpoch.current) {
                            setModal(null);
                            setSpawnTask(""); setSpawnSteps([createTaskStep()]); setSpawnMode("single"); setSpawnModel("");
                            setSpawnSolutionSpace("");
                          }
                        })
                        .finally(() => {
                          if (epoch === spawnEpoch.current)
                            spawnLock.current = false;
                        });
                    }}
                  >
                    {preview && marks
                      ? zh
                        ? "预览创建"
                        : "Preview creation"
                      : zh
                        ? "创建并启动"
                        : "Create and start"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head">
                  <b>{zh ? "结束任务？" : "End task?"}</b>
                  <button
                    className="icon-btn small"
                    type="button"
                    aria-label={zh ? "关闭" : "Close"}
                    data-tip={zh ? "关闭" : "Close"}
                    onClick={() => setModal(null)}
                  >
                    <Icon name="x" extra="sm" />
                  </button>
                </div>
                <div className="modal-body">
                  <div
                    className="small"
                    style={{ color: "var(--text-2)", lineHeight: 1.6 }}
                  >
                    {zh ? (
                      <>
                        确定结束
                        {killTarget?.name ? `「${killTarget.name}」` : "这个任务"}
                        吗？结束后无法恢复。
                      </>
                    ) : (
                      <>
                        Are you sure you want to end{" "}
                        {killTarget?.name ? `"${killTarget.name}"` : "this task"}?
                        This cannot be undone.
                      </>
                    )}
                    {killCaps.killWhy ? (
                      <div style={{ marginTop: 8 }}>{killCaps.killWhy}</div>
                    ) : null}
                  </div>
                </div>
                <div className="modal-foot">
                  <button
                    className="btn outline"
                    type="button"
                    onClick={() => setModal(null)}
                  >
                    {zh ? "取消" : "Cancel"}
                  </button>
                  <button
                    className="btn danger solid"
                    type="button"
                    disabled={!killCaps.kill || commandBusy}
                    onClick={() => {
                      if (killTarget && killCaps.kill) {
                        killAgent(killTarget);
                        setModal(null);
                      }
                    }}
                  >
                    Kill
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

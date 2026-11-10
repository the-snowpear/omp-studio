import type { RuntimeFeatureResultMap } from "@omp-studio/studio-protocol";
import { PREVIEW_TASK_SPAWN_OPTIONS } from "./preview/taskSpawnPreview";
import { SlidingTabs } from "./SlidingTabs";
import { AppSelect } from "./AppSelect";
import { AgentModelDetails } from "./models/AgentModelDetails";
import { PREVIEW_AGENT_DEFINITIONS } from "./preview/agentSpawnPreview";
import { ModelDelegationList } from "./ModelDelegationList";
import { AgentBtwPane } from "./btw/AgentBtwPane";
import { ServicesPane } from "./services/ServicesPane";
import { WorkspacePanel, WorkspaceTabs } from "./workspaces/Workspace";
import { useI18n } from "./i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { type HubTab } from "./pageIntents";
import { clearHubIntent, loadPersisted, persist, readHubIntent } from "./agents/hub/navigation";
import { type HubAgent, type HubJob, type HubStatus, type HubView, type Modal, type Notice } from "./agents/hub/types";
import { CONTRACT, capsFor, missingCap } from "./agents/hub/capabilities";
import { STATUS_DOT, STATUS_LABEL, TABS, activityPill, fmtAge, fmtClock, fmtCost, fmtDur, fmtNum, fromPreviewAgent, fromPreviewJob, hubChatTarget, hubComposerAgents, hubDurationMs, hubSelectorId, hubWord, linearSeq, sortByCreation, toHubAgent, toHubJob, treeGroups } from "./agents/hub/projection";
import { hubFaceClass, useHubChatCloseMotion } from "./agents/hub/useHubChatMotion";
import { AgentCard, EmptyBlock, KbdHint, TreeGroup } from "./agents/hub/AgentCards";
import { HubAgentOverview } from "./agents/hub/HubAgentOverview";
import { HubJobRow } from "./agents/hub/HubJobRow";

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
  const [view, setView] = useState<HubView>(initial.view);
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
  const [commandBusy, setCommandBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [spawnTask, setSpawnTask] = useState("");
  const [spawnEffort, setSpawnEffort] = useState("");
  const [spawnModel, setSpawnModel] = useState("");
  const [spawnFileMode, setSpawnFileMode] = useState(false);
  const [spawnFile, setSpawnFile] = useState("");
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
  const searchRef = useRef<HTMLInputElement>(null);
  const transcriptReq = useRef(0);

  useEffect(() => {
    persist({ selectedBySession, tab, view });
  }, [selectedBySession, tab, view]);

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
    const tick = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 900);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [workspaceTab, setWorkspaceTab] = useState<
    "agents" | "jobs" | "services"
  >("agents");
  const runtimeStatus = runtime?.status ?? "unavailable";
  const connOnline = runtimeStatus === "connected" && !resyncRequired;
  const viewingLive =
    parentSessionId === undefined || snapshot?.sessionId === parentSessionId;
  const spawnAvailable =
    preview ||
    (viewingLive &&
      connOnline &&
      client !== undefined &&
      !missingCap(capabilities, "agent.spawn"));
  useEffect(() => {
    spawnEpoch.current++;
    spawnLock.current = false;
    setSpawnDefinitions(preview ? PREVIEW_AGENT_DEFINITIONS : null);
    setSpawnDefinition(preview ? PREVIEW_AGENT_DEFINITIONS[0]!.name : "");
    setSpawnEffort("");
    return () => {
      spawnEpoch.current++;
    };
  }, [client, preview, parentSessionId, snapshot?.sessionId]);
  useEffect(() => {
    let alive = true;
    setSpawnOptions(undefined); setSpawnOptionsError(""); setSpawnModel(""); setSpawnFileMode(false);
    if (modal?.kind !== "spawn" || !spawnDefinition) return;
    if (preview) { setSpawnOptions(PREVIEW_TASK_SPAWN_OPTIONS); return; }
    if (!client || !snapshot?.sessionId || missingCap(capabilities, "agent.spawn.options")) return;
    void client.query("agent.spawn.options.read", { sessionId: snapshot.sessionId, definition: spawnDefinition }).then(result => { if (alive) setSpawnOptions(result); }).catch(error => { if (alive) setSpawnOptionsError(error instanceof Error ? error.message : String(error)); });
    return () => { alive = false; };
  }, [modal?.kind, spawnDefinition, client, snapshot?.sessionId, capabilities, preview]);
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
      const fixture = buildPreviewHub();
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
        mainName: "主对话",
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
              : "等待 Runtime snapshot",
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
      mainName: main?.name ?? "主对话",
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
            : "等待 Runtime snapshot"),
      mainMeta,
      runtimeLabel: undefined as string | undefined,
    };
  }, [preview, snapshot, agents, viewingLive, parentSessionId]);

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
  );

  const runCommand = useCallback(
    async <TName extends CommandName>(
      name: TName,
      input: CommandInput<TName>,
      okText: string,
    ): Promise<boolean> => {
      if (preview) {
        setNotice({ kind: "warn", text: CONTRACT.previewWrite });
        return false;
      }
      if (!viewingLive) {
        setNotice({ kind: "warn", text: CONTRACT.historicalWrite });
        return false;
      }
      if (!client) {
        setNotice({ kind: "warn", text: "无 Studio client（桌面桥未注入）" });
        return false;
      }
      setCommandBusy(true);
      try {
        const handle = await client.command(name, input);
        await waitReceipt(client, handle.requestId);
        setNotice({ kind: "ok", text: okText });
        return true;
      } catch (error) {
        setNotice({ kind: "err", text: hostErrorMessage(error, "操作失败") });
        return false;
      } finally {
        setCommandBusy(false);
      }
    },
    [client, preview, viewingLive],
  );

  const cancelJob = useCallback(
    (job: HubJob) => {
      void runCommand(
        "job.cancel",
        { jobId: job.id, expectedGeneration: job.generation },
        `job ${job.id} 取消已提交`,
      );
    },
    [runCommand],
  );

  const reviveAgent = useCallback(
    (agent: HubAgent) => {
      void runCommand(
        "agent.revive",
        { agentId: agent.id, expectedGeneration: agent.generation },
        `${agent.name} revive 已提交`,
      );
    },
    [runCommand],
  );

  const releaseAgent = useCallback(
    (agent: HubAgent) => {
      void runCommand(
        "agent.release",
        { agentId: agent.id, expectedGeneration: agent.generation },
        `${agent.name} release 已提交`,
      );
    },
    [runCommand],
  );

  const killAgent = useCallback(
    (agent: HubAgent) => {
      void runCommand(
        "agent.kill",
        { agentId: agent.id, expectedGeneration: agent.generation },
        `${agent.name} 已结束`,
      );
    },
    [runCommand],
  );

  const sendDraft = useCallback(
    (agent: HubAgent) => {
      const text = draft.trim();
      if (!text) return;
      void runCommand(
        "agent.send",
        {
          agentId: agent.id,
          expectedGeneration: agent.generation,
          text,
          mode: "prompt",
        },
        `消息已发送给 ${agent.name}`,
      ).then((ok) => {
        if (ok) setDraft("");
      });
    },
    [draft, runCommand],
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
            row.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

  const warn = (text: string) => setNotice({ kind: "warn", text });

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
          setTranscriptError(hostErrorMessage(error, "读取 transcript 失败"));
      })
      .finally(() => {
        if (!cancelled && req === transcriptReq.current)
          setTranscriptBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [preview, viewingLive, tab, agentId, agentGeneration, client]);

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
          setTranscriptError(hostErrorMessage(error, "读取 transcript 失败"));
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
    const onKey = (event: KeyboardEvent) => {
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
      const seq = linearSeq(filtered, view);
      const index = seq.findIndex((agent) => agent.id === selected);
      switch (event.key) {
        case "j":
        case "ArrowDown":
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
            else warn(caps.openWhy ?? "已结束");
          }
          break;
        case "t":
          event.preventDefault();
          setView((current) => (current === "flat" ? "tree" : "flat"));
          break;
        case "r":
          if (selectedAgent) {
            event.preventDefault();
            if (caps.revive) reviveAgent(selectedAgent);
            else warn(caps.reviveWhy ?? CONTRACT.revive);
          }
          break;
        case "x":
          if (selectedAgent) {
            event.preventDefault();
            if (caps.kill)
              setModal({ kind: "kill", agentId: selectedAgent.id });
            else warn(caps.killWhy ?? CONTRACT.kill);
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
    drawerOpen,
    filtered,
    openChat,
    reviveAgent,
    select,
    selected,
    selectedAgent,
    view,
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
  const usage = useMemo(() => {
    const metrics = filtered
      .map((agent) => agent.metrics)
      .filter((item): item is PreviewMetrics => Boolean(item));
    if (!metrics.length) return `Usage — · 0/${filtered.length} measured`;
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
    return `${fmtCost(total.cost)} · ${fmtDur(total.durationMs)} active agent time · ${total.requests} req · ${total.tools} tools · ${fmtNum(total.tokens)} tok · ${total.timed}/${metrics.length} timed · ${metrics.length}/${filtered.length} measured`;
  }, [filtered]);

  const renderList = () => {
    if (!filtered.length) {
      if (query.trim()) {
        return (
          <div className="hub-empty-list">
            <Icon name="search" />
            <b>没有匹配的 Agent</b>
            <span>试试其他 id、名称、任务或模型关键字。</span>
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
            data-tip={
              preview
                ? zh
                  ? "演示创建，不会执行任务"
                  : "Preview creation; no task runs"
                : !viewingLive
                  ? CONTRACT.historicalWrite
                  : missingCap(capabilities, "agent.spawn")
                    ? CONTRACT.spawn
                    : undefined
            }
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
  const renderOverview = (agent: HubAgent) => <HubAgentOverview zh={zh} select={select} agent={agent} />;
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
            ? CONTRACT.cancel
            : "取消走 runtime 确认门；运行中的 job 才可取消（owner-scoped）"}
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

  const renderDetailBody = (agent: HubAgent) => {
    if(tab === "btw")return <AgentBtwPane key={`${parentSessionId ?? snapshot?.sessionId}:${agent.id}`} client={client} sessionId={parentSessionId ?? snapshot?.sessionId} agentId={agent.id} available={connOnline && viewingLive && !resyncRequired && agent.kind!=="main" && agent.hasLiveSession && !missingCap(capabilities,"agent.btw.read")}/>;
    if (tab === "transcript") {
      if (preview) {
        return (
          <>
            <div className="hub-transcript" id="hubTranscript">
              <EmptyBlock
                icon="message"
                detail={
                  agent.hasTranscript
                    ? "预览模式不读取真实 transcript"
                    : "No messages yet."
                }
              />
            </div>
            <div className="hub-ro-banner">
              <Icon name="lock" extra="sm" />
              <span>预览模式不调用 Host 写操作</span>
            </div>
          </>
        );
      }
      if (!viewingLive) {
        return (
          <>
            <div className="hub-transcript" id="hubTranscript">
              <EmptyBlock
                icon="message"
                detail="历史会话请用「打开」查看归档对话，不读取 live transcript。"
              />
            </div>
            <div className="hub-ro-banner">
              <Icon name="lock" extra="sm" />
              <span>{CONTRACT.historicalWrite}</span>
            </div>
          </>
        );
      }
      const page = transcriptPage?.agentId === agent.id ? transcriptPage : null;
      return (
        <>
          <div className="hub-transcript" id="hubTranscript">
            {transcriptBusy && !page ? (
              <EmptyBlock icon="message" detail="读取 transcript…" />
            ) : null}
            {transcriptError ? (
              <EmptyBlock icon="alert" detail={transcriptError} />
            ) : null}
            {!transcriptBusy && !transcriptError && !page ? (
              <EmptyBlock
                icon="message"
                detail={
                  agent.hasTranscript ? CONTRACT.transcript : "No messages yet."
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
                加载更早消息
              </button>
            ) : null}
          </div>
          <div className="hub-send">
            <input
              className="input"
              type="text"
              placeholder={
                caps.chat
                  ? `发消息给 ${agent.name}（prompt）…`
                  : (caps.chatWhy ?? CONTRACT.chat)
              }
              aria-label="发送消息"
              value={draft}
              disabled={!caps.chat || commandBusy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur();
                if (
                  event.key === "Enter" &&
                  !event.nativeEvent.isComposing &&
                  draft.trim()
                ) {
                  event.preventDefault();
                  sendDraft(agent);
                }
              }}
            />
            <button
              className="btn small primary"
              type="button"
              disabled={!caps.chat || commandBusy || !draft.trim()}
              data-tip={caps.chatWhy ?? undefined}
              onClick={() => sendDraft(agent)}
            >
              <Icon name="message" extra="sm" />
              发送
            </button>
          </div>
          {agent.status === "parked" ? (
            <div className="hub-cap-note">
              <Icon name="clock" extra="sm" />
              {agent.isolated || agent.canRevive === false
                ? "仅保留记录和产物，不可自动 revive"
                : "parked agent：发送将自动 revive（outcome=revived）"}
            </div>
          ) : null}
        </>
      );
    }
    if (tab === "jobs") return renderJobs(agent);
    if (tab === "messages") {
      return (
        <>
          <div className="hub-ro-banner" style={{ margin: "0 0 var(--sp-12)" }}>
            <Icon name="lock" extra="sm" />
            <span>{CONTRACT.irc}</span>
          </div>
          <div className="hub-irc-list">
            <EmptyBlock
              icon="message"
              detail={
                agent.unread > 0
                  ? `${agent.unread} 条未读（内容读取本轮未接入）`
                  : "没有与该 Agent 的 IRC 往来"
              }
            />
          </div>
        </>
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
      className={`hub-page${chatOpen && workspaceTab === "agents" ? " is-chat-preview" : ""}${chatClosing && workspaceTab === "agents" ? " is-chat-closing" : ""}`}
      id="hubRoot"
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
      {!modal && notice ? (
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
            <b>正在重连</b>
            <span className="hc-detail">
              与 runtime 的连接中断，正在重试… roster 为最后一次同步的快照。
            </span>
          </div>
        ) : null}
        {connKind === "resync" ? (
          <div className="hub-conn blue">
            <span className="spinner" />
            <b>状态回源中</b>
            <span className="hc-detail">
              正在恢复最新 Runtime 状态，敏感操作已暂停。
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
          <div className="seg" role="group" aria-label="Roster 视图">
            <button
              type="button"
              className={view === "flat" ? "active" : undefined}
              onClick={() => setView("flat")}
            >
              {zh ? "平铺" : "Flat"}
            </button>
            <button
              type="button"
              className={view === "tree" ? "active" : undefined}
              onClick={() => setView("tree")}
            >
              {zh ? "按父代理" : "By parent"}
            </button>
          </div>
          <div className="hub-status-counts">
            {(["running", "idle", "parked", "aborted"] as const)
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
            aria-label="搜索 Agent"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>

        {filtered.length ? (
          <div className="hub-usage">
            <span>{usage}</span>
            <span className="spacer" />
            <button
              className="btn small primary"
              type="button"
              disabled={!spawnAvailable || commandBusy}
              data-tip={
                preview
                  ? zh
                    ? "演示创建，不会执行任务"
                    : "Preview creation; no task runs"
                  : !viewingLive
                    ? CONTRACT.historicalWrite
                    : missingCap(capabilities, "agent.spawn")
                      ? CONTRACT.spawn
                      : undefined
              }
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
          className={`hub-cols${chatOpen ? " is-chat-preview" : ""}`}
          ref={colsRef}
        >
          <div
            className={`hub-list${view === "tree" ? " tree" : ""}`}
            id="hubList"
            ref={listRef}
            role="listbox"
            aria-label="子 Agent 列表"
          >
            {renderList()}
          </div>
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
                              className="btn small outline"
                              type="button"
                              onClick={() => setChatOpen(false)}
                            >
                              <Icon name="arrow-l" extra="sm" />
                              返回
                            </button>
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
                          <div className="hub-detail-head">
                            <div className="hd-title">
                              <button
                                className="icon-btn small hub-drawer-back"
                                type="button"
                                data-tip="返回"
                                onClick={() => setDrawerOpen(false)}
                              >
                                <Icon name="arrow-l" extra="sm" />
                              </button>
                              <b>{selectedAgent.name}</b>

                              <span
                                className={`chip ${selectedAgent.kind === "advisor" ? "gray" : "purple"} xs`}
                              >
                                {selectedAgent.kind === "advisor"
                                  ? zh
                                    ? "顾问"
                                    : "Advisor"
                                  : zh
                                    ? "子代理"
                                    : "Subagent"}
                              </span>
                              {selectedAgent.parentId ? (
                                <button
                                  className="hub-child-link tiny"
                                  type="button"
                                  onClick={() =>
                                    !mapped.roster.some(
                                      (agent) =>
                                        agent.id === selectedAgent.parentId,
                                    )
                                      ? onOpenMain()
                                      : select(selectedAgent.parentId!, {
                                          scroll: true,
                                        })
                                  }
                                >
                                  {zh ? "父代理" : "Parent"}:{" "}
                                  {mapped.roster.find(
                                    (agent) =>
                                      agent.id === selectedAgent.parentId,
                                  )?.name ??
                                    (selectedAgent.parentId === "main"
                                      ? zh
                                        ? "主对话"
                                        : "Main"
                                      : selectedAgent.parentId)}
                                </button>
                              ) : null}
                              <span className="spacer" />
                              <span
                                className={`hub-act ${activityPill(selectedAgent, zh).cls}`}
                              >
                                {activityPill(selectedAgent, zh).label}
                              </span>
                            </div>
                            <div className="hd-sub">
                              <span className="hub-status-line">
                                <span
                                  className={`dot ${STATUS_DOT[selectedAgent.status]}`}
                                />
                                {hubWord(
                                  STATUS_LABEL[selectedAgent.status],
                                  zh,
                                )}{" "}
                                ·{" "}
                                {(() => {
                                  const durationMs = hubDurationMs(
                                    selectedAgent,
                                    now,
                                  );
                                  return durationMs === undefined
                                    ? "—"
                                    : fmtDur(durationMs);
                                })()}{" "}
                                · {zh ? "最近活动" : "Last active"}{" "}
                                {fmtAge(selectedAgent.lastActivity, now, zh)}
                              </span>
                              {selectedAgent.modelRole ? (
                                <span className="hub-role">
                                  {selectedAgent.modelRole}
                                </span>
                              ) : null}
                              {selectedAgent.fallback ? (
                                <span className="hub-model hub-fallback">
                                  {zh ? "回退模型" : "Fallback"} →{" "}
                                  {selectedAgent.fallback}
                                </span>
                              ) : selectedAgent.resolvedModel ? (
                                <span className="hub-model">
                                  {selectedAgent.resolvedModel}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <details className="small hub-native-details">
                            <summary>
                              {zh
                                ? "身份与原始状态"
                                : "Identity and native state"}
                            </summary>
                            <p className="mono">
                              {selectedAgent.id} ·{" "}
                              {selectedAgent.rawStatus ?? selectedAgent.status}{" "}
                              · {selectedAgent.kind}
                            </p>
                          </details>
                          <AgentModelDetails
                            client={client}
                            sessionId={snapshot?.sessionId}
                            agentId={selectedAgent.id}
                            available={viewingLive && connOnline}
                            capabilities={capabilities}
                            running={selectedAgent.status === "running"}
                            previewModel={selectedAgent.resolvedModel}
                            previewSaved={!selectedAgent.hasLiveSession}
                          />
                          <div className="hub-detail-actions">
                            <button
                              className="btn small primary"
                              type="button"
                              disabled={!caps.open}
                              data-tip={caps.openWhy ?? undefined}
                              onClick={() => openChat(selectedAgent.id)}
                            >
                              <Icon name="external" extra="sm" />
                              {zh ? "打开" : "Open"}
                            </button>
                            <button
                              className="btn small outline"
                              type="button"
                              disabled={!caps.chat || commandBusy}
                              data-tip={caps.chatWhy ?? undefined}
                              onClick={() => openChat(selectedAgent.id)}
                            >
                              <Icon name="message" extra="sm" />
                              {zh ? "发消息" : "Send message"}
                            </button>
                            <button
                              className="btn small outline"
                              type="button"
                              disabled={!caps.revive || commandBusy}
                              data-tip={caps.reviveWhy ?? undefined}
                              onClick={() => reviveAgent(selectedAgent)}
                            >
                              <Icon name="refresh" extra="sm" />
                              {zh ? "恢复" : "Revive"}
                            </button>
                            <button
                              className="btn small danger"
                              type="button"
                              disabled={!caps.kill || commandBusy}
                              data-tip={caps.killWhy ?? undefined}
                              onClick={() => {
                                if (!caps.kill)
                                  warn(caps.killWhy ?? CONTRACT.kill);
                                else
                                  setModal({
                                    kind: "kill",
                                    agentId: selectedAgent.id,
                                  });
                              }}
                            >
                              <Icon name="stop" extra="sm" />
                              {zh ? "停止" : "Stop"}
                            </button>
                            {selectedAgent.status === "aborted" ? (
                              <button
                                className="btn small outline"
                                type="button"
                                disabled={!caps.release || commandBusy}
                                data-tip={caps.releaseWhy ?? undefined}
                                onClick={() => releaseAgent(selectedAgent)}
                              >
                                <Icon name="x" extra="sm" />
                                {zh ? "释放" : "Release"}
                              </button>
                            ) : null}
                          </div>
                          <div className="hub-detail-tabs">
                            <SlidingTabs id="hubTabs" ariaLabel={zh ? "Agent 详情" : "Agent details"} value={tab} orientation="horizontal" className="tabs"
                              items={TABS.map(([id, label]) => ({ id, label: hubWord(label, zh), icon: "bot", buttonId: `hub-tab-${id}`, panelId: "hubDetailBody" }))}
                              onChange={id => { setTab(id); setNotice(null); }} />
                          </div>
                          <div className="hub-detail-body" id="hubDetailBody">
                            {renderDetailBody(selectedAgent)}
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
                <b>未选择 Agent</b>
                <span>从左侧列表选择一个子 Agent 查看详情。</span>
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
          onMouseDown={() => setModal(null)}
        >
          <div
            className="modal hub-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.kind === "spawn"
                ? zh
                  ? "创建代理"
                  : "New Agent"
                : "结束任务"
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
                    <div className="hub-na-row">
                      <div className="field">
                        <label className="tiny muted" htmlFor="naTask">
                          {zh ? "任务描述" : "Assignment"}
                        </label>
                        <label className="tiny muted"><input type="checkbox" checked={spawnFileMode} disabled={!spawnOptions?.fileEnabled || commandBusy} onChange={event => setSpawnFileMode(event.target.checked)} />{zh ? "使用任务文件" : "Use a task file"}</label>
                        {spawnFileMode ? <input className="input" id="naTask" value={spawnFile} onChange={event => setSpawnFile(event.target.value)} placeholder={zh ? "当前工作环境中的绝对路径或 local:// 文件" : "Absolute path in this environment or local:// file"} disabled={!spawnAvailable || commandBusy} /> :
                        <textarea
                          className="input"
                          id="naTask"
                          rows={3}
                          placeholder={
                            zh
                              ? "描述代理需要完成的工作…"
                              : "Describe the work for this agent…"
                          }
                          value={spawnTask}
                          onChange={(event) => setSpawnTask(event.target.value)}
                          disabled={!spawnAvailable || commandBusy}
                        />}
                      </div>
                    </div>
                    <div className="hub-na-row">
                      <div className="field">
                        <label className="tiny muted" htmlFor="naSolutionSpace">解题范围 / Solution space</label>
                        <textarea className="input" id="naSolutionSpace" rows={3} maxLength={65536} value={spawnSolutionSpace} onChange={event => setSpawnSolutionSpace(event.target.value)} placeholder="允许探索的方案、限制与边界 / Allowed approaches and constraints" disabled={!preview && (commandBusy || missingCap(capabilities, "session.skills.list"))} />
                        <label className="tiny muted" htmlFor="naRole">
                          {zh ? "代理定义" : "Agent definition"}
                        </label>
                        <AppSelect
                          className="select"
                          id="naRole"
                          value={spawnDefinition}
                          onChange={(event) =>
                            setSpawnDefinition(event.target.value)
                          }
                          disabled={
                            !spawnAvailable ||
                            commandBusy ||
                            spawnDefinitions === null ||
                            spawnDefinitions.length === 0
                          }
                        >
                          {spawnDefinitions === null ? (
                            <option value="">
                              {zh ? "读取定义中…" : "Loading definitions…"}
                            </option>
                          ) : spawnDefinitions.length === 0 ? (
                            <option value="">
                              {zh
                                ? "暂无可用代理定义"
                                : "No agent definitions available"}
                            </option>
                          ) : (
                            spawnDefinitions.map((definition) => (
                              <option
                                key={definition.name}
                                value={definition.name}
                              >
                                {definition.name}
                                {definition.description
                                  ? ` — ${definition.description.slice(0, 60)}`
                                  : ""}
                              </option>
                            ))
                          )}
                        </AppSelect>
                      </div>
                      <div className="field">
                        <label className="tiny muted" htmlFor="naEffort">
                          {zh ? "本次思考强度" : "Thinking effort for this run"}
                        </label>
                        <AppSelect
                          className="select"
                          id="naEffort"
                          value={spawnEffort}
                          onChange={(event) =>
                            setSpawnEffort(event.target.value)
                          }
                          disabled={!spawnAvailable || commandBusy}
                        >
                          <option value="">
                            {zh ? "继承代理定义" : "Inherit agent definition"}
                          </option>
                          <option value="lo">{zh ? "轻量" : "Low"}</option>
                          <option value="med">{zh ? "标准" : "Medium"}</option>
                          <option value="hi">{zh ? "深入" : "High"}</option>
                        </AppSelect>
                      </div>
                    </div>
                    {spawnOptionsError ? <p className="small" role="alert">{spawnOptionsError}</p> : null}
                    <div className="field"><label className="tiny muted" htmlFor="naModel">{zh ? "单次任务模型" : "Model for this task"}</label><AppSelect id="naModel" className="select" value={spawnModel} disabled={!spawnOptions?.modelSelection || commandBusy} onChange={event => setSpawnModel(event.target.value)}><option value="">{zh ? "使用代理配置" : "Use agent configuration"}</option>{spawnOptions?.models.map(model => <option key={model.selector} value={model.selector}>{model.name} · {model.selector}</option>)}</AppSelect><p className="tiny muted">{spawnOptions?.modelSelection ? (zh ? "只显示原生策略授权的精确模型；本次不会切换到其他模型。" : "Only exact models granted by native policy; this task will not switch to another model.") : (zh ? "可在设置 → 任务中开启单次模型选择。" : "Enable per-call models in Settings → Tasks.")}{spawnOptions ? ` · max effort: ${spawnOptions.maxEffort}` : ""}</p></div>
                    <div className="agent-spawn-config" role="status">
                      <strong>{zh ? "使用代理配置" : "Agent configuration"}</strong>
                      <p className="small muted">{zh
                        ? "模型和备用链由所选代理的配置决定，可在模型工作区的代理页编辑。"
                        : "Models and fallbacks come from the selected agent. Edit them in Models → Agents."}</p>
                      <code>{spawnDefinitions?.find(item => item.name === spawnDefinition)?.model?.join(" → ")
                        || (zh ? "使用原生角色与代理模型配置" : "Use native role and agent model settings")}</code>
                    </div>
                    {preview ? (
                      <p className="tiny muted">
                        {zh
                          ? "演示：只预览任务配置，不会创建真实代理或调用模型。"
                          : "Demo: preview task configuration without creating an agent or calling a model."}
                      </p>
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
                    className="btn primary"
                    type="button"
                    disabled={
                      !spawnAvailable ||
                      commandBusy ||
                      !(spawnFileMode ? spawnFile.trim() : spawnTask.trim()) ||
                      !spawnDefinition
                    }
                    data-tip={
                      preview
                        ? zh
                          ? "演示创建，不会执行任务"
                          : "Preview creation; no task runs"
                        : !viewingLive
                          ? CONTRACT.historicalWrite
                          : missingCap(capabilities, "agent.spawn")
                            ? CONTRACT.spawn
                            : undefined
                    }
                    onClick={() => {
                      if (spawnLock.current || !spawnAvailable) return;
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
                        setNotice({
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
                          ...(spawnFileMode ? { taskFile: spawnFile.trim() } : { assignment: spawnTask }),
                          ...(spawnModel ? { model: [spawnModel] } : {}),
                          ...(spawnSolutionSpace.trim() ? { solutionSpace: spawnSolutionSpace.trim() } : {}),
                          async: true,
                          ...(spawnEffort ? { effort: spawnEffort } : {}),
                        },
                        zh ? "代理任务已提交" : "Agent task submitted",
                      )
                        .then((ok) => {
                          if (ok && epoch === spawnEpoch.current) {
                            setModal(null);
                            setSpawnTask(""); setSpawnFile(""); setSpawnModel("");
                            setSpawnSolutionSpace("");
                          }
                        })
                        .finally(() => {
                          if (epoch === spawnEpoch.current)
                            spawnLock.current = false;
                        });
                    }}
                  >
                    {preview
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
                  <b>结束任务？</b>
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
                    确定结束
                    {killTarget?.name ? `「${killTarget.name}」` : "这个任务"}
                    吗？结束后无法恢复。
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

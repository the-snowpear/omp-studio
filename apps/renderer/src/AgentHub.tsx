import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import type { ClientBootstrap, CommandInput, CommandName, StudioClient } from "@omp-studio/client-contract";
import type {
  AgentId,
  AgentTranscriptMessage,
  OpaqueCursor,
  OperatorStateSnapshot,
  StudioAgentSnapshot,
  StudioJobSnapshot,
} from "@omp-studio/studio-protocol";
import type { MentionCandidate } from "./composer/types";
import { Icon } from "./icons";
import { buildPreviewHub } from "./hubPreview";
import type { PreviewAgent, PreviewJob, PreviewMetrics } from "./hubPreview";
import { usePreviewMode } from "./preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "./hostError";
import { SubagentConversationPane } from "./conversation/SubagentConversationPane";
import type { SubagentComposerAgent } from "./conversation/subagentComposerGate";
import { isRealSubagentId, type SubagentHubTarget } from "./conversation/toolMeta";
import { pageMotionReduced, TAB_PANE_MS, tabPaneRole, useOverlappingTabs, type SlideDir, type TabPaneRole } from "./pageTransition";

export const HUB_INTENT_KEY = "omp.hubIntent";
const HUB_STATE_KEY = "omp.agentHub.state";

export type HubTab = "overview" | "transcript" | "jobs" | "messages";
export type HubIntentTab = HubTab | "chat";
export type HubView = "flat" | "tree";

type HubStatus = "running" | "idle" | "parked" | "aborted";
type Notice = { kind: "ok" | "warn" | "err"; text: string };
type Modal =
  | { kind: "spawn" }
  | { kind: "kill"; agentId: string };

type HubAgent = {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  status: HubStatus;
  rawStatus: StudioAgentSnapshot["status"] | HubStatus;
  activity?: string;
  task: string;
  currentTool?: { name: string; args?: string } | null;
  lastIntent?: string | null;
  retryState?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  modelRole?: string;
  resolvedModel?: string;
  fallback?: string | null;
  metrics?: PreviewMetrics;
  readOnly: boolean;
  unread: number;
  outputPath?: string | null;
  patchPath?: string | null;
  branchName?: string | null;
  children: string[];
  activeJobIds: string[];
  startedAt?: number;
  lastActivity: number;
  hasLiveSession: boolean;
  hasTranscript: boolean;
  generation: number;
};

type HubJob = {
  id: string;
  type: string;
  status: StudioJobSnapshot["status"];
  label: string;
  durationMs: number;
  ownerId: string;
  generation: number;
  resultText?: string;
  errorText?: string;
};

type Caps = {
  open: boolean;
  openWhy: string | null;
  chat: boolean;
  chatWhy: string | null;
  revive: boolean;
  reviveWhy: string | null;
  kill: boolean;
  killWhy: string | null;
  release: boolean;
  releaseWhy: string | null;
};

type Persisted = {
  selected: string | null;
  tab: HubTab;
  view: HubView;
};

const STATUS_LABEL: Record<HubStatus, string> = {
  running: "running",
  idle: "idle",
  parked: "parked",
  aborted: "aborted",
};

const STATUS_DOT: Record<HubStatus, string> = {
  running: "green pulse",
  idle: "blue",
  parked: "gray",
  aborted: "red",
};

const STATUS_ORDER: Record<HubStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

const TABS: ReadonlyArray<readonly [HubTab, string]> = [
  ["overview", "Overview"],
  ["transcript", "Transcript"],
  ["jobs", "Jobs"],
  ["messages", "Messages"],
];

const JOB_CHIP: Record<StudioJobSnapshot["status"], string> = {
  queued: "gray",
  running: "blue",
  completed: "green",
  failed: "red",
  cancelled: "gray",
};

const CONTRACT = {
  chat: "发送（暂未实现）",
  revive: "Revive（暂未实现）",
  kill: "停止（暂未实现）",
  release: "释放（暂未实现）",
  spawn: "派生（暂未实现）",
  cancel: "取消（暂未实现）",
  transcript: "无 transcript",
  irc: "IRC（暂未实现）",
  previewWrite: "预览模式",
} as const;

type HubIntent = { agentId: string; tab?: HubTab; chat?: boolean };

export function setHubIntent(agentId: string, tab?: HubIntentTab): void {
  if (!isRealSubagentId(agentId)) return;
  try {
    const openChat = tab === "chat";
    sessionStorage.setItem(HUB_INTENT_KEY, JSON.stringify({
      agentId,
      tab: openChat ? null : (tab ?? null),
      ...(openChat ? { chat: true } : {}),
    }));
  } catch {
    /* sessionStorage may be blocked; navigation still opens the hub. */
  }
}

function parseHubTab(value: unknown): HubTab | undefined {
  if (value === "overview" || value === "transcript" || value === "jobs" || value === "messages") return value;
  return undefined;
}

function parseHubIntent(raw: string): HubIntent | null {
  try {
    const parsed = JSON.parse(raw) as { agentId?: unknown; tab?: unknown; chat?: unknown };
    if (typeof parsed.agentId !== "string" || !isRealSubagentId(parsed.agentId)) return null;
    const tab = parseHubTab(parsed.tab);
    return {
      agentId: parsed.agentId,
      ...(tab !== undefined ? { tab } : {}),
      ...(parsed.chat === true ? { chat: true } : {}),
    };
  } catch {
    return null;
  }
}

function readHubIntent(): HubIntent | null {
  try {
    const raw = sessionStorage.getItem(HUB_INTENT_KEY);
    if (!raw) return null;
    const parsed = parseHubIntent(raw);
    if (!parsed) sessionStorage.removeItem(HUB_INTENT_KEY);
    return parsed;
  } catch {
    return null;
  }
}

function clearHubIntent(): void {
  try {
    sessionStorage.removeItem(HUB_INTENT_KEY);
  } catch {
    /* sessionStorage may be blocked. */
  }
}

function loadPersisted(): Persisted {
  try {
    const saved = JSON.parse(localStorage.getItem(HUB_STATE_KEY) || "{}") as Partial<Persisted>;
    return {
      selected: typeof saved.selected === "string" && isRealSubagentId(saved.selected) ? saved.selected : null,
      tab: parseHubTab(saved.tab) ?? "overview",
      view: saved.view === "tree" ? "tree" : "flat",
    };
  } catch {
    return { selected: null, tab: "overview", view: "flat" };
  }
}

function persist(state: Persisted): void {
  try {
    localStorage.setItem(HUB_STATE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage may be blocked; UI state stays in-memory. */
  }
}

function parseTs(value?: string): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function fmtAge(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (!Number.isFinite(s)) return "—";
  if (s < 5) return "刚刚";
  if (s < 60) return `${s}s 前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m 前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d 前`;
  return `${Math.floor(d / 30)}mo 前`;
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function fmtClock(ts: number): string {
  if (!Number.isFinite(ts)) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtHM(ts: number): string {
  return fmtClock(ts).slice(0, 5);
}

function fmtCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function fmtNum(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function fmtMetrics(metrics?: PreviewMetrics): string {
  if (!metrics) return "usage —";
  return `${fmtCost(metrics.cost)} · ${fmtDur(metrics.durationMs)} · ${metrics.requests} req · ${metrics.tools} tools · ${fmtNum(metrics.tokens)} tok`;
}

function sparkLevel(tokens: number): number {
  return Math.max(1, Math.min(3, Math.round(tokens / 40000)));
}

function hubStatus(status: StudioAgentSnapshot["status"]): HubStatus {
  if (status === "starting" || status === "running" || status === "reviving") return "running";
  if (status === "idle") return "idle";
  if (status === "parked") return "parked";
  return "aborted";
}

function isAdvisor(agent: HubAgent): boolean {
  return agent.kind === "advisor";
}

function hubComposerAgents(roster: readonly HubAgent[]): SubagentComposerAgent[] {
  return roster.map((agent) => ({
    agentId: agent.id,
    kind: agent.kind,
    status: agent.rawStatus,
    readOnly: agent.readOnly,
    generation: agent.generation,
  }));
}

function hubFaceClass(role: TabPaneRole | null, dir: SlideDir): string {
  return role ? `hub-face hub-face-${role}-${dir}` : "hub-face";
}

/** Shrink the roster grid from the chat-preview height in the same 320ms as the back-facing pane swap. */
function useHubChatCloseMotion(
  chatOpen: boolean,
  incoming: "chat" | "detail",
  colsRef: RefObject<HTMLDivElement | null>,
): boolean {
  const [closing, setClosing] = useState(false);
  const fromRef = useRef(0);
  const fromHoldRef = useRef(0);
  const toHoldRef = useRef(0);

  useLayoutEffect(() => {
    if (!chatOpen) return;
    const el = colsRef.current;
    if (el) fromRef.current = el.getBoundingClientRect().height;
  });

  useLayoutEffect(() => {
    const el = colsRef.current;
    if (chatOpen) {
      if (el) {
        el.style.height = "";
        el.style.transition = "";
      }
      if (closing) setClosing(false);
      return;
    }
    if (incoming !== "detail") return;
    if (pageMotionReduced() || !el) {
      fromRef.current = 0;
      if (closing) setClosing(false);
      return;
    }
    if (!closing) {
      const from = fromRef.current;
      fromRef.current = 0;
      if (from <= 0) return;
      const to = el.getBoundingClientRect().height;
      if (Math.abs(from - to) < 1) return;
      fromHoldRef.current = from;
      toHoldRef.current = to;
      setClosing(true);
      return;
    }
    const from = fromHoldRef.current;
    const to = toHoldRef.current;
    el.style.height = `${from}px`;
    el.style.transition = "none";
    void el.getBoundingClientRect();
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      el.style.transition = `height ${TAB_PANE_MS}ms var(--ease-nav)`;
      el.style.height = `${to}px`;
    });
    const finish = () => {
      if (cancelled) return;
      cancelled = true;
      el.style.height = "";
      el.style.transition = "";
      setClosing(false);
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== "height") return;
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(finish, TAB_PANE_MS + 80);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      el.removeEventListener("transitionend", onEnd);
      window.clearTimeout(fallback);
      el.style.height = "";
      el.style.transition = "";
    };
  }, [chatOpen, closing, colsRef, incoming]);

  return closing;
}

function activityPill(agent: HubAgent): { cls: string; label: string } {
  if (agent.status === "aborted" || agent.rawStatus === "failed") {
    return { cls: "aborted", label: agent.rawStatus === "failed" ? "Failed" : "Aborted" };
  }
  if (agent.status === "running") {
    if (agent.activity === "tool") {
      return { cls: "tool", label: agent.currentTool?.name ? `Running Tool · ${agent.currentTool.name}` : "Running Tool" };
    }
    return { cls: "thinking", label: "Thinking" };
  }
  if (agent.status === "idle") {
    if (agent.activity === "waiting") return { cls: "waiting", label: "Waiting for User" };
    if (agent.activity === "failed") return { cls: "aborted", label: "Failed" };
    return { cls: "idle", label: "Idle" };
  }
  if (agent.status === "parked") return { cls: "parked", label: "Parked" };
  return { cls: "parked", label: agent.status };
}

function toHubAgent(agent: StudioAgentSnapshot, children: string[]): HubAgent {
  const usage = agent.usage;
  const metrics: PreviewMetrics | undefined = usage
    ? {
        cost: usage.cost,
        durationMs: usage.durationMs,
        ...(usage.durationKind !== undefined ? { durationKind: usage.durationKind } : {}),
        requests: usage.requests,
        tools: usage.tools,
        tokens: usage.tokens,
        ...(usage.contextTokens !== undefined && usage.contextWindow !== undefined
          ? { contextTokens: usage.contextTokens, contextWindow: usage.contextWindow }
          : {}),
      }
    : undefined;
  return {
    id: agent.agentId,
    name: agent.displayName,
    kind: agent.kind,
    ...(agent.parentAgentId ? { parentId: agent.parentAgentId } : {}),
    status: hubStatus(agent.status),
    rawStatus: agent.status,
    task: agent.assignment ?? agent.summary ?? "—",
    ...(agent.modelRole !== undefined ? { modelRole: agent.modelRole } : {}),
    ...(agent.resolvedModel !== undefined ? { resolvedModel: agent.resolvedModel } : {}),
    ...(agent.modelIsFallback === true && agent.resolvedModel !== undefined
      ? { fallback: agent.resolvedModel }
      : {}),
    ...(metrics ? { metrics } : {}),
    readOnly: agent.kind === "advisor" || agent.readOnly === true,
    unread: agent.unreadCount,
    ...(agent.outputPath !== undefined ? { outputPath: agent.outputPath } : {}),
    ...(agent.patchPath !== undefined ? { patchPath: agent.patchPath } : {}),
    ...(agent.branchName !== undefined ? { branchName: agent.branchName } : {}),
    children,
    activeJobIds: agent.activeJobIds,
    ...(Number.isFinite(parseTs(agent.startedAt)) ? { startedAt: parseTs(agent.startedAt) } : {}),
    lastActivity: Number.isFinite(parseTs(agent.updatedAt)) ? parseTs(agent.updatedAt) : Date.now(),
    hasLiveSession: agent.hasLiveSession,
    hasTranscript: agent.hasTranscript,
    generation: agent.generation,
  };
}

function hubSelectorId(id: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(id);
  return id.replace(/[\n\r\\"\]]/g, (ch) => `\\${ch}`);
}

function hubChatTarget(agent: HubAgent): SubagentHubTarget {
  return {
    agentId: agent.id,
    toolCallId: agent.id,
    ...(agent.task && agent.task !== "—" ? { task: agent.task } : {}),
  };
}

function toHubJob(job: StudioJobSnapshot): HubJob {
  const started = parseTs(job.startedAt);
  const ended = parseTs(job.completedAt);
  const durationMs = Number.isFinite(started)
    ? Math.max(0, (Number.isFinite(ended) ? ended : Date.now()) - started)
    : 0;
  return {
    id: job.jobId,
    type: job.type,
    status: job.status,
    label: job.label,
    durationMs,
    ownerId: job.ownerAgentId,
    generation: job.generation,
    ...(job.status === "completed" && job.summary ? { resultText: job.summary } : {}),
    ...(job.status === "failed" && job.summary ? { errorText: job.summary } : {}),
  };
}

function fromPreviewAgent(agent: PreviewAgent): HubAgent {
  return {
    id: agent.id,
    name: agent.name,
    kind: agent.kind,
    ...(agent.parentId ? { parentId: agent.parentId } : {}),
    status: agent.status,
    rawStatus: agent.status,
    activity: agent.activity,
    task: agent.task,
    currentTool: agent.currentTool ?? null,
    lastIntent: agent.lastIntent ?? null,
    retryState: agent.retryState ?? null,
    ...(agent.modelRole ? { modelRole: agent.modelRole } : {}),
    ...(agent.resolvedModel ? { resolvedModel: agent.resolvedModel } : {}),
    fallback: agent.fallback ?? null,
    ...(agent.metrics ? { metrics: agent.metrics } : {}),
    readOnly: Boolean(agent.readOnly || agent.kind === "advisor"),
    unread: agent.ircUnread ?? 0,
    outputPath: agent.outputPath ?? null,
    patchPath: agent.patchPath ?? null,
    branchName: agent.branchName ?? null,
    children: agent.children,
    activeJobIds: [],
    startedAt: agent.createdAt,
    lastActivity: agent.lastActivity,
    hasLiveSession: agent.status !== "aborted",
    hasTranscript: Boolean(agent.hasTranscript),
    generation: 1,
  };
}

function fromPreviewJob(job: PreviewJob): HubJob {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    label: job.label,
    durationMs: job.durationMs,
    ownerId: job.ownerId,
    generation: 1,
    ...(job.resultText ? { resultText: job.resultText } : {}),
    ...(job.errorText ? { errorText: job.errorText } : {}),
  };
}

function sortFlat(rows: HubAgent[]): HubAgent[] {
  return rows.slice().sort((a, b) =>
    (STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    || (b.lastActivity - a.lastActivity)
    || (a.id < b.id ? -1 : 1));
}

function sortTree(rows: HubAgent[]): HubAgent[] {
  return rows.slice().sort((a, b) => (b.lastActivity - a.lastActivity) || (a.id < b.id ? -1 : 1));
}

function treeGroups(rows: HubAgent[]): { groups: Array<{ head: HubAgent; kids: HubAgent[] }>; orphans: HubAgent[] } {
  const byId = new Map(rows.map((agent) => [agent.id, agent]));
  const hasVisParent = (agent: HubAgent) => Boolean(agent.parentId && agent.parentId !== "main" && byId.has(agent.parentId));
  const isGroupHead = (agent: HubAgent) => !hasVisParent(agent) && rows.some((row) => row.parentId === agent.id);
  const heads = sortTree(rows.filter(isGroupHead));
  const used = new Set(heads.map((head) => head.id));
  const groups = heads.map((head) => {
    const kids = sortTree(rows.filter((row) => row.parentId === head.id));
    kids.forEach((kid) => used.add(kid.id));
    return { head, kids };
  });
  return { groups, orphans: sortTree(rows.filter((agent) => !used.has(agent.id))) };
}

function linearSeq(rows: HubAgent[], view: HubView): HubAgent[] {
  if (view !== "tree") return sortFlat(rows);
  const tree = treeGroups(rows);
  return [...tree.groups.flatMap((group) => [group.head, ...group.kids]), ...tree.orphans];
}

function missingCap(capabilities: ClientBootstrap["capabilityManifest"] | undefined, id: string): boolean {
  const entry = capabilities?.capabilities.find((item) => item.id === id);
  return !entry || entry.grade === "unavailable";
}

function lockedWhy(agent: HubAgent): string {
  return isAdvisor(agent) ? "只读" : "read-only";
}

function capsFor(
  agent: HubAgent | undefined,
  connOnline: boolean,
  capabilities: ClientBootstrap["capabilityManifest"] | undefined,
  hasClient: boolean,
  preview: boolean,
): Caps {
  if (!agent) {
    return {
      open: false, openWhy: null, chat: false, chatWhy: null,
      revive: false, reviveWhy: null, kill: false, killWhy: null,
      release: false, releaseWhy: null,
    };
  }
  const dead = agent.status === "aborted";
  const locked = isAdvisor(agent) || agent.readOnly;
  const chatMissing = missingCap(capabilities, "agent.send");
  const reviveMissing = missingCap(capabilities, "agent.revive");
  const killMissing = missingCap(capabilities, "agent.kill");
  const releaseMissing = missingCap(capabilities, "agent.release");
  const hostReady = connOnline && hasClient;
  return {
    open: !dead,
    openWhy: dead ? "已结束" : null,
    chat: !locked && !dead && (preview || (hostReady && !chatMissing)),
    chatWhy: locked ? lockedWhy(agent)
      : dead ? "已结束"
      : preview ? null
      : !hasClient ? "无 Studio client"
      : !connOnline ? "未连接"
      : chatMissing ? CONTRACT.chat
      : null,
    revive: !preview && !locked && agent.status === "parked" && hostReady && !reviveMissing,
    reviveWhy: preview ? CONTRACT.previewWrite
      : locked ? lockedWhy(agent)
      : agent.status !== "parked" ? "仅 parked"
      : !hasClient ? "无 Studio client"
      : !connOnline ? "未连接"
      : reviveMissing ? CONTRACT.revive
      : null,
    kill: !preview && !locked && !dead && hostReady && !killMissing,
    killWhy: preview ? CONTRACT.previewWrite
      : locked ? lockedWhy(agent)
      : dead ? "已结束"
      : !hasClient ? "无 Studio client"
      : !connOnline ? "未连接"
      : killMissing ? CONTRACT.kill
      : null,
    release: !preview && !locked && dead && hostReady && !releaseMissing,
    releaseWhy: preview ? CONTRACT.previewWrite
      : locked ? lockedWhy(agent)
      : !dead ? "仅终态"
      : !hasClient ? "无 Studio client"
      : !connOnline ? "未连接"
      : releaseMissing ? CONTRACT.release
      : null,
  };
}

function KbdHint() {
  return <div className="hub-kbd-hint">j/k 选择 · Enter 打开 · r revive · x kill · t 切换视图</div>;
}

function StatusDot({ status }: { status: HubStatus }) {
  return <span className={`hub-sd ${status}${status === "running" ? " pulse" : ""}`} aria-hidden="true" />;
}

function FlagChips({ agent, kids }: { agent: HubAgent; kids?: number }) {
  return (
    <>
      {agent.unread > 0 ? <span className="hub-unread" data-tip={`${agent.unread} 未读`}><Icon name="message" extra="sm" />{agent.unread}</span> : null}
      {agent.readOnly ? <span className="hub-ro-tag">read-only</span> : null}
      {kids ? <span className="hub-ro-tag" data-tip="子 Agent">↳ {kids} 子</span> : null}
    </>
  );
}

function Spark({ tokens }: { tokens: number }) {
  const hot = sparkLevel(tokens);
  return (
    <svg className="hc-spark" width="13" height="8" viewBox="0 0 13 8" aria-hidden="true">
      {[1, 2, 3].map((index) => (
        <rect key={index} className={`hb-bar${index <= hot ? " hot" : ""}`} x={(index - 1) * 5} y={8 - index * 2} width="3" height={index * 2} rx="1" />
      ))}
    </svg>
  );
}

function ArtChips({ agent }: { agent: HubAgent }) {
  const chips = [agent.outputPath ? "out" : null, agent.patchPath ? "patch" : null, agent.branchName ? "branch" : null].filter((chip): chip is string => Boolean(chip));
  if (!chips.length) return null;
  return <span className="hc-art">{chips.map((chip) => <span className="hub-art" key={chip}>{chip}</span>)}</span>;
}

function ModelLine({ agent }: { agent: HubAgent }) {
  if (agent.fallback) return <span className="hub-model hub-fallback">fallback → {agent.fallback}</span>;
  if (agent.resolvedModel) return <span className="hub-model">{agent.resolvedModel}</span>;
  return null;
}

function AgentCard({ agent, selected, kids, onSelect }: { agent: HubAgent; selected: boolean; kids: number; onSelect: (id: string) => void }) {
  const pill = activityPill(agent);
  const metrics = agent.metrics;
  return (
    <button className={`hub-card${selected ? " sel" : ""}`} type="button" role="option" aria-selected={selected} data-hub-id={agent.id} onClick={() => onSelect(agent.id)}>
      <span className="hc-main">
        <span className="hc-top">
          <span className={`hub-act ${pill.cls}`}>{pill.label}</span>
          <span className="hc-name"><StatusDot status={agent.status} /><span>{agent.name}</span></span>
          {(agent.unread > 0 || agent.readOnly || kids > 0) ? <span className="hc-flags"><FlagChips agent={agent} kids={kids} /></span> : null}
        </span>
        <span className="hc-task">{agent.task}</span>
        <span className="hc-foot">
          {agent.modelRole ? <span className="hub-role">{agent.modelRole}</span> : null}
          <ModelLine agent={agent} />
          <ArtChips agent={agent} />
        </span>
      </span>
      <span className="hc-side">
        {agent.startedAt ? <span className="hc-start" data-tip={`已运行 ${fmtDur(metrics?.durationMs ?? (Date.now() - agent.startedAt))}`}><Icon name="clock" extra="sm" />{fmtHM(agent.startedAt)}</span> : null}
        {metrics ? <span className="hc-tokens"><b>{fmtNum(metrics.tokens)}</b><i>tok</i><Spark tokens={metrics.tokens} /></span> : null}
        {metrics ? <span className="hc-pace"><span className="hub-num"><i>req</i><b>{metrics.requests}</b></span><span className="hub-num"><i>tools</i><b>{metrics.tools}</b></span></span> : null}
        <span className="hc-cost">{metrics ? fmtCost(metrics.cost) : "usage —"}</span>
      </span>
    </button>
  );
}

function AgentNode({ agent, selected, now, onSelect }: { agent: HubAgent; selected: boolean; now: number; onSelect: (id: string) => void }) {
  const pill = activityPill(agent);
  return (
    <button className={`hub-node st-${agent.status}${selected ? " sel" : ""}`} type="button" role="option" aria-selected={selected} data-hub-id={agent.id} onClick={() => onSelect(agent.id)}>
      <span className="hn-top">
        <span className={`hub-act ${pill.cls}`}>{pill.label}</span>
        <span className="hn-name"><StatusDot status={agent.status} /><span>{agent.name}</span></span>
        {(agent.unread > 0 || agent.readOnly) ? <span className="hn-flags"><FlagChips agent={agent} /></span> : null}
        {agent.metrics ? <span className="hn-cost">{fmtCost(agent.metrics.cost)}</span> : null}
      </span>
      <span className="hn-task">{agent.task}</span>
      <span className="hn-foot">
        {agent.modelRole ? <span className="hub-role">{agent.modelRole}</span> : null}
        <span className="mono">{agent.fallback ? `fallback → ${agent.fallback}` : (agent.resolvedModel ?? "")}</span>
        <span>{fmtAge(agent.lastActivity, now)}</span>
        <span className="hn-art"><ArtChips agent={agent} /></span>
      </span>
    </button>
  );
}

function TreeGroup({ head, kids, selected, now, onSelect }: { head: HubAgent; kids: HubAgent[]; selected: string | null; now: number; onSelect: (id: string) => void }) {
  const pill = activityPill(head);
  const cost = [head, ...kids].reduce((sum, agent) => sum + (agent.metrics?.cost ?? 0), 0);
  return (
    <div className="hub-tgroup">
      <button className={`hub-tg-head${selected === head.id ? " sel" : ""}`} type="button" role="option" aria-selected={selected === head.id} data-hub-id={head.id} onClick={() => onSelect(head.id)}>
        <span className="tg-ic"><Icon name="bot" extra="sm" /></span>
        <span className={`hub-act ${pill.cls}`}>{pill.label}</span>
        <span className="tg-name"><StatusDot status={head.status} /><span>{head.name}</span></span>
        <span className="tg-task">{head.task}</span>
        <span className="tg-right">
          <FlagChips agent={head} kids={kids.length} />
          <span className="tg-cost">{fmtCost(cost)}</span>
          <span className="tg-caret"><Icon name="chevron-d" extra="sm" /></span>
        </span>
      </button>
      <div className="hub-tchildren">
        <span className="hub-trail" aria-hidden="true" />
        <div className="hub-tleaves">
          {kids.map((kid) => <AgentNode key={kid.id} agent={kid} selected={selected === kid.id} now={now} onSelect={onSelect} />)}
        </div>
      </div>
    </div>
  );
}

function Kv({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <div className="k">{label}</div>
      <div className={`v${mono ? " mono" : ""}`}>{children}</div>
    </div>
  );
}

function EmptyBlock({ icon, title, detail }: { icon: string; title?: string; detail: string }) {
  return (
    <div className="hub-empty-list" style={{ border: "none", padding: "var(--sp-24)" }}>
      <Icon name={icon} />
      {title ? <b>{title}</b> : null}
      <span>{detail}</span>
    </div>
  );
}

export function AgentHubPage({
  snapshot,
  runtime,
  resyncRequired,
  capabilities,
  client,
  canSend,
  runtimeConnected,
  workspaceId,
  loadMentions,
  onOpenMain,
}: {
  snapshot?: OperatorStateSnapshot;
  runtime?: ClientBootstrap["runtime"];
  resyncRequired?: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"];
  client?: StudioClient;
  canSend?: boolean;
  runtimeConnected?: boolean;
  workspaceId?: string;
  loadMentions?: (trigger: "@" | "/", query: string) => Promise<readonly MentionCandidate[]>;
  onOpenMain: () => void;
}) {
  const initial = useMemo(loadPersisted, []);
  const [selected, setSelected] = useState<string | null>(initial.selected);
  const [tab, setTab] = useState<HubTab>(initial.tab);
  const [view, setView] = useState<HubView>(initial.view);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [jobsTab, setJobsTab] = useState<"mine" | "all">("mine");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [now, setNow] = useState(Date.now());
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth <= 900);
  const [commandBusy, setCommandBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [spawnTask, setSpawnTask] = useState("");
  const [spawnDefinition, setSpawnDefinition] = useState("");
  const [spawnDefinitions, setSpawnDefinitions] = useState<ReadonlyArray<{ name: string; description: string }> | null>(null);
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
    persist({ selected, tab, view });
  }, [selected, tab, view]);

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
  const runtimeStatus = runtime?.status ?? "unavailable";
  const connOnline = runtimeStatus === "connected" && !resyncRequired;
  const chatRuntimeConnected = runtimeConnected ?? connOnline;
  const chatCanSend = canSend ?? false;
  const limited = runtime?.classification === "limited-system";
  const connKind = runtimeStatus === "unavailable" || runtimeStatus === "disconnected"
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
        mainName: fixture.main.name,
        mainStatus: fixture.main.statusText,
        mainTask: fixture.main.task,
        mainMeta: `${fixture.main.model} · ${fmtDur(fixture.main.durationMs)} · ctx ${fixture.main.contextPct}%`,
        runtimeLabel: fixture.runtimeLabel,
      };
    }
    const source = snapshot?.agents ?? [];
    if (source.length === 0) {
      return {
        preview: false,
        roster: [],
        jobs: [],
        mainName: "主对话",
        mainStatus: snapshot?.activeMode ?? "idle",
        mainTask: snapshot ? `session ${snapshot.sessionId}` : "等待 Runtime snapshot",
        mainMeta: snapshot ? `${snapshot.activeMode} · pending ${snapshot.pendingMessages}` : "usage —",
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
    const all = source.map((agent) => toHubAgent(agent, childMap.get(agent.agentId) ?? []));
    const main = all.find((agent) => agent.kind === "main");
    const roster = all.filter((agent) => agent.kind !== "main");
    const telemetry = snapshot?.telemetry;
    const mainMeta = telemetry
      ? `${snapshot?.activeMode ?? "idle"} · ${fmtNum(telemetry.tokens.total)} tok · ${fmtCost(telemetry.tokens.cost)} · ctx ${telemetry.context ? `${Math.round(telemetry.context.percent)}%` : "—"}`
      : snapshot
        ? `${snapshot.activeMode} · pending ${snapshot.pendingMessages} · agents ${roster.length}`
        : "usage —";
    return {
      preview: false,
      roster,
      jobs: (snapshot?.jobs ?? []).map(toHubJob),
      mainName: main?.name ?? "主对话",
      mainStatus: snapshot?.isStreaming ? "Streaming" : snapshot?.activeMode ?? "idle",
      mainTask: main?.task ?? (snapshot ? `session ${snapshot.sessionId}` : "等待 Runtime snapshot"),
      mainMeta,
      runtimeLabel: undefined as string | undefined,
    };
  }, [preview, snapshot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mapped.roster;
    return mapped.roster.filter((agent) => `${agent.name} ${agent.id} ${agent.task} ${agent.kind} ${agent.modelRole ?? ""} ${agent.resolvedModel ?? ""}`.toLowerCase().includes(q));
  }, [mapped.roster, query]);

  const selectedAgent = mapped.roster.find((agent) => agent.id === selected);
  const caps = capsFor(selectedAgent, connOnline, capabilities, client !== undefined, preview);
  const killTarget = modal?.kind === "kill"
    ? mapped.roster.find((agent) => agent.id === modal.agentId)
    : undefined;
  const killCaps = capsFor(killTarget, connOnline, capabilities, client !== undefined, preview);

  const runCommand = useCallback(async <TName extends CommandName>(
    name: TName,
    input: CommandInput<TName>,
    okText: string,
  ): Promise<boolean> => {
    if (preview) {
      setNotice({ kind: "warn", text: CONTRACT.previewWrite });
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
  }, [client, preview]);

  const cancelJob = useCallback((job: HubJob) => {
    void runCommand("job.cancel", { jobId: job.id, expectedGeneration: job.generation }, `job ${job.id} 取消已提交`);
  }, [runCommand]);

  const reviveAgent = useCallback((agent: HubAgent) => {
    void runCommand("agent.revive", { agentId: agent.id, expectedGeneration: agent.generation }, `${agent.name} revive 已提交`);
  }, [runCommand]);

  const releaseAgent = useCallback((agent: HubAgent) => {
    void runCommand("agent.release", { agentId: agent.id, expectedGeneration: agent.generation }, `${agent.name} release 已提交`);
  }, [runCommand]);

  const killAgent = useCallback((agent: HubAgent) => {
    void runCommand("agent.kill", { agentId: agent.id, expectedGeneration: agent.generation }, "Kill 已提交；请在弹出的交互确认卡中确认（destructive）");
  }, [runCommand]);

  const sendDraft = useCallback((agent: HubAgent) => {
    const text = draft.trim();
    if (!text) return;
    void runCommand("agent.send", { agentId: agent.id, expectedGeneration: agent.generation, text, mode: "prompt" }, `消息已发送给 ${agent.name}`).then((ok) => {
      if (ok) setDraft("");
    });
  }, [draft, runCommand]);

  const select = useCallback((id: string, opts?: { scroll?: boolean }) => {
    setSelected(id);
    setNotice(null);
    if (typeof window !== "undefined" && window.innerWidth <= 900) setDrawerOpen(true);
    if (opts?.scroll) {
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector(`[data-hub-id="${hubSelectorId(id)}"]`);
        if (row && typeof row.scrollIntoView === "function") {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      });
    }
  }, []);

  useEffect(() => {
    const intent = readHubIntent();
    if (!intent) return;
    if (!mapped.preview && snapshot === undefined) return;
    if (!mapped.roster.some((agent) => agent.id === intent.agentId)) {
      if (mapped.preview || snapshot !== undefined) clearHubIntent();
      return;
    }
    if (intent.tab) setTab(intent.tab);
    if (intent.chat) setChatOpen(true);
    select(intent.agentId, { scroll: true });
    clearHubIntent();
  }, [mapped.preview, mapped.roster, select, snapshot]);

  const openChat = useCallback((id: string) => {
    setChatOpen(true);
    select(id);
  }, [select]);

  useEffect(() => {
    if (chatOpen && selectedAgent === undefined) setChatOpen(false);
  }, [chatOpen, selectedAgent]);

  const chatFace: "chat" | "detail" = chatOpen ? "chat" : "detail";
  const { incoming, outgoing, dir, live, stageRef } = useOverlappingTabs(chatFace, chatOpen ? 1 : 0);
  const chatClosing = useHubChatCloseMotion(chatOpen, incoming, colsRef);
  const hubFaces: ReadonlyArray<"detail" | "chat"> = outgoing != null && outgoing !== incoming
    ? [outgoing, incoming]
    : [incoming];

  const warn = (text: string) => setNotice({ kind: "warn", text });

  const agentId = selectedAgent?.id;
  const agentGeneration = selectedAgent?.generation;
  useEffect(() => {
    const req = ++transcriptReq.current;
    if (preview || tab !== "transcript" || agentId === undefined || client === undefined) {
      setTranscriptPage(null);
      setTranscriptError(null);
      return;
    }
    let cancelled = false;
    setTranscriptBusy(true);
    setTranscriptError(null);
    client.query("agent.transcript.read", { agentId: agentId as AgentId, limit: 50 })
      .then((page) => {
        if (cancelled || req !== transcriptReq.current) return;
        setTranscriptPage({
          agentId,
          generation: page.generation,
          messages: page.messages,
          ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
          eof: page.eof,
        });
      })
      .catch((error) => {
        if (!cancelled && req === transcriptReq.current) setTranscriptError(hostErrorMessage(error, "读取 transcript 失败"));
      })
      .finally(() => {
        if (!cancelled && req === transcriptReq.current) setTranscriptBusy(false);
      });
    return () => { cancelled = true; };
  }, [preview, tab, agentId, agentGeneration, client]);

  const loadMoreTranscript = useCallback(() => {
    if (preview || client === undefined || selectedAgent === undefined || transcriptPage?.nextCursor === undefined) return;
    const cursor = transcriptPage.nextCursor as OpaqueCursor;
    const agent = selectedAgent;
    const req = transcriptReq.current;
    setTranscriptBusy(true);
    client.query("agent.transcript.read", { agentId: agent.id as AgentId, cursor, limit: 50 })
      .then((page) => {
        if (req !== transcriptReq.current) return;
        setTranscriptPage((current) => {
          if (current === null || current.agentId !== agent.id) return current;
          const seen = new Set(current.messages.map((message) => message.id));
          const merged = [...current.messages, ...page.messages.filter((message) => !seen.has(message.id))];
          return {
            agentId: current.agentId,
            generation: page.generation,
            messages: merged,
            ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
            eof: page.eof,
          };
        });
      })
      .catch((error) => {
        if (req === transcriptReq.current) setTranscriptError(hostErrorMessage(error, "读取 transcript 失败"));
      })
      .finally(() => {
        if (req === transcriptReq.current) setTranscriptBusy(false);
      });
  }, [preview, client, selectedAgent, transcriptPage?.nextCursor]);

  useEffect(() => {
    if (modal?.kind !== "spawn" || preview || client === undefined || spawnDefinitions !== null) return;
    let cancelled = false;
    client.query("agents.definitions.get", {})
      .then((model) => {
        if (cancelled) return;
        const agents = model.agents.map((definition) => ({ name: definition.name, description: definition.description }));
        setSpawnDefinitions(agents);
        setSpawnDefinition((current) => current || agents[0]?.name || "");
      })
      .catch(() => {
        if (!cancelled) setSpawnDefinitions([]);
      });
    return () => { cancelled = true; };
  }, [modal, preview, client, spawnDefinitions]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = Boolean(target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
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
          if (seq.length) select(seq[Math.min(seq.length - 1, Math.max(0, index) + (index < 0 ? 0 : 1))]!.id, { scroll: true });
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          if (seq.length) select(seq[Math.max(0, index < 0 ? 0 : index - 1)]!.id, { scroll: true });
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
          setView((current) => current === "flat" ? "tree" : "flat");
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
            if (caps.kill) setModal({ kind: "kill", agentId: selectedAgent.id });
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
  }, [caps.kill, caps.killWhy, caps.open, caps.openWhy, caps.revive, caps.reviveWhy, chatOpen, drawerOpen, filtered, openChat, reviveAgent, select, selected, selectedAgent, view]);

  const counts = useMemo(() => {
    const next: Partial<Record<HubStatus, number>> = {};
    for (const agent of mapped.roster) next[agent.status] = (next[agent.status] ?? 0) + 1;
    return next;
  }, [mapped.roster]);

  const runtimeLabel = mapped.runtimeLabel ?? (limited ? "Limited Runtime" : runtime?.classification ?? "OMP Runtime");
  const mainName = mapped.mainName;
  const mainTask = mapped.mainTask;
  const mainStatus = mapped.mainStatus;
  const mainMeta = mapped.mainMeta;
  const usage = useMemo(() => {
    const metrics = filtered.map((agent) => agent.metrics).filter((item): item is PreviewMetrics => Boolean(item));
    if (!metrics.length) return `Usage — · 0/${filtered.length} measured`;
    const seed = { cost: 0, durationMs: 0, requests: 0, tools: 0, tokens: 0, timed: 0 };
    const total = metrics.reduce((sum, item) => ({
      cost: sum.cost + item.cost,
      durationMs: sum.durationMs + item.durationMs,
      requests: sum.requests + item.requests,
      tools: sum.tools + item.tools,
      tokens: sum.tokens + item.tokens,
      timed: sum.timed + (item.durationKind && item.durationKind !== "unknown" ? 1 : 0),
    }), seed);
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
          <span>Finished, parked, and killed subagents remain with the session that created them.</span>
          <span className="tiny">Resume that session with <span className="mono">omp --continue</span>, or spawn a task here.</span>
          <button className="btn small primary" type="button" onClick={() => setModal({ kind: "spawn" })}>
            <Icon name="plus" extra="sm" />New Agent
          </button>
        </div>
      );
    }
    if (view === "tree") {
      const tree = treeGroups(filtered);
      const childIds = new Set(tree.groups.flatMap((group) => group.kids.map((kid) => kid.id)));
      return (
        <>
          {tree.groups.map((group) => (
            <TreeGroup key={group.head.id} head={group.head} kids={group.kids} selected={selected} now={now} onSelect={select} />
          ))}
          {tree.orphans.map((agent) => (
            <AgentCard key={agent.id} agent={agent} selected={selected === agent.id} kids={agent.children.filter((id) => !childIds.has(id)).length} onSelect={select} />
          ))}
          <KbdHint />
        </>
      );
    }
    return (
      <>
        {sortFlat(filtered).map((agent) => (
          <AgentCard key={agent.id} agent={agent} selected={selected === agent.id} kids={agent.children.length} onSelect={select} />
        ))}
        <KbdHint />
      </>
    );
  };

  const renderOverview = (agent: HubAgent) => {
    const metrics = agent.metrics;
    const ctxPct = metrics?.contextWindow
      ? Math.max(0, Math.min(100, Math.round((metrics.contextTokens ?? 0) / metrics.contextWindow * 100)))
      : null;
    const currentEmpty = !agent.currentTool && !agent.lastIntent && !agent.retryState && agent.activeJobIds.length === 0 && !(agent.status === "running" && agent.task !== "—");
    return (
      <>
        <div className="hub-sec-title">Task</div>
        <div className="hub-kv"><Kv label="Task">{agent.task}</Kv></div>
        <div className="hub-sec-title">Current</div>
        <div className="hub-kv">
          {agent.currentTool ? <Kv label="Tool"><span className="chip blue xs">{agent.currentTool.name}</span>{agent.currentTool.args ? ` ${agent.currentTool.args}` : ""}</Kv> : null}
          {agent.lastIntent ? <Kv label="Last intent">{agent.lastIntent}</Kv> : null}
          {agent.retryState ? <Kv label="Retry"><span style={{ color: "var(--amber)" }}>retry {agent.retryState.attempt}/{agent.retryState.maxAttempts}</span>{agent.retryState.errorMessage ? ` · ${agent.retryState.errorMessage}` : ""}</Kv> : null}
          {agent.status === "running" && agent.task !== "—" ? <Kv label="Activity">上游 activity gist：{agent.task}</Kv> : null}
          {agent.activeJobIds.length ? <Kv label="Active jobs" mono>{agent.activeJobIds.join(" · ")}</Kv> : null}
          {currentEmpty ? <Kv label="—">无进行中的工具调用</Kv> : null}
        </div>
        <div className="hub-sec-title">Usage</div>
        <div className="hub-kv">
          <Kv label="Metrics" mono>{fmtMetrics(metrics)}</Kv>
          {ctxPct != null && metrics?.contextWindow != null ? (
            <div className="kv">
              <div className="k">Context</div>
              <div className="v">
                <div className="hub-ctx">
                  <div className={`meter${ctxPct > 80 ? " danger" : ctxPct > 60 ? " warn" : ""}`}><i style={{ width: `${ctxPct}%` }} /></div>
                  <span className="mono">{fmtNum(metrics.contextTokens ?? 0)} / {fmtNum(metrics.contextWindow)} · {ctxPct}%</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="hub-sec-title">Lineage</div>
        <div className="hub-kv">
          <Kv label="Spawned by">{agent.parentId ?? "main"}</Kv>
          <div className="kv">
            <div className="k">Children</div>
            <div className="v">
              {agent.children.length
                ? (
                  <span className="hub-lineage-row">
                    {agent.children.map((id) => (
                      <button key={id} className="hub-child-link" type="button" onClick={() => select(id, { scroll: true })}>
                        <Icon name="bot" extra="sm" />{id}
                      </button>
                    ))}
                  </span>
                )
                : "0 children"}
            </div>
          </div>
          <Kv label="Registered" mono>{agent.startedAt ? new Date(agent.startedAt).toISOString() : "—"}</Kv>
        </div>
        <div className="hub-sec-title">Changes</div>
        <div className="hub-kv">
          <Kv label="Mode">{isAdvisor(agent) || agent.readOnly ? "Read-only · 0 LoC" : "Shared workspace · per-agent LoC not attributable"}</Kv>
          {agent.outputPath ? <Kv label="Output" mono>{agent.outputPath} <span className="tiny muted">agent://{agent.id}</span></Kv> : null}
          {agent.patchPath ? <Kv label="Patch" mono>{agent.patchPath}</Kv> : null}
          {agent.branchName ? <Kv label="Worktree branch" mono>{agent.branchName}</Kv> : null}
        </div>
      </>
    );
  };

  const renderJobs = (agent: HubAgent) => {
    const mine = mapped.jobs.filter((job) => job.ownerId === agent.id);
    const rows = jobsTab === "all" ? mapped.jobs : mine;
    return (
      <>
        <div className="seg" role="group" aria-label="Jobs 范围" style={{ marginBottom: "var(--sp-10)" }}>
          <button type="button" className={jobsTab === "mine" ? "active" : undefined} onClick={() => setJobsTab("mine")}>该 Agent</button>
          <button type="button" className={jobsTab === "all" ? "active" : undefined} onClick={() => setJobsTab("all")}>全部</button>
        </div>
        <div className="hub-cap-note" style={{ marginBottom: "var(--sp-8)" }}>
          <Icon name="lock" extra="sm" />{missingCap(capabilities, "job.cancel") ? CONTRACT.cancel : "取消走 runtime 确认门；运行中的 job 才可取消（owner-scoped）"}
        </div>
        {rows.length
          ? rows.map((job) => (
            <div className="hub-job" key={job.id}>
              <span className={`a-ic ${job.type === "bash" ? "blue" : "purple"}`} aria-hidden="true">
                <Icon name={job.type === "bash" ? "terminal" : "bot"} extra="sm" />
              </span>
              <div className="jb-label">
                <span className="ellipsis" style={{ display: "block" }}>{job.label}</span>
                <span className="mono">{job.id} · {job.type} · {fmtDur(job.durationMs)}{job.ownerId !== agent.id ? ` · owner ${job.ownerId}` : ""}</span>
                {job.errorText ? <span className="mono" style={{ color: "var(--red)" }}>{job.errorText}</span> : null}
                {job.resultText ? <span className="mono" style={{ color: "var(--green)" }}>{job.resultText}</span> : null}
              </div>
              <span className={`chip ${JOB_CHIP[job.status]} xs`}>{job.status}</span>
              {job.status === "running" && job.ownerId === agent.id
                ? (
                  <button
                    className="btn small outline"
                    type="button"
                    disabled={preview || commandBusy || !connOnline || !client || missingCap(capabilities, "job.cancel")}
                    data-tip={missingCap(capabilities, "job.cancel") ? CONTRACT.cancel : undefined}
                    onClick={() => cancelJob(job)}
                  >
                    取消
                  </button>
                )
                : null}
            </div>
          ))
          : <EmptyBlock icon="terminal" detail={`没有${jobsTab === "mine" ? "该 Agent 的" : ""} job`} />}
      </>
    );
  };

  const renderDetailBody = (agent: HubAgent) => {
    if (tab === "transcript") {
      if (preview) {
        return (
          <>
            <div className="hub-transcript" id="hubTranscript">
              <EmptyBlock icon="message" detail={agent.hasTranscript ? "预览模式不读取真实 transcript" : "No messages yet."} />
            </div>
            <div className="hub-ro-banner"><Icon name="lock" extra="sm" /><span>预览模式不调用 Host 写操作</span></div>
          </>
        );
      }
      const page = transcriptPage?.agentId === agent.id ? transcriptPage : null;
      return (
        <>
          <div className="hub-transcript" id="hubTranscript">
            {transcriptBusy && !page ? <EmptyBlock icon="message" detail="读取 transcript…" /> : null}
            {transcriptError ? <EmptyBlock icon="alert" detail={transcriptError} /> : null}
            {!transcriptBusy && !transcriptError && !page ? <EmptyBlock icon="message" detail={agent.hasTranscript ? CONTRACT.transcript : "No messages yet."} /> : null}
            {page
              ? page.messages.map((message) => (
                <div className={`hub-tr-msg ${message.role}`} key={message.id}>
                  <div className="tr-head">
                    <span className="tr-role">{message.role}</span>
                    <span className="mono tiny muted">{fmtClock(message.ts)}</span>
                  </div>
                  <div className="tr-body">{message.text}</div>
                </div>
              ))
              : null}
            {page && page.nextCursor !== undefined
              ? (
                <button className="btn small outline" type="button" disabled={transcriptBusy} style={{ margin: "var(--sp-8) auto" }} onClick={loadMoreTranscript}>
                  加载更早消息
                </button>
              )
              : null}
          </div>
          <div className="hub-send">
            <input
              className="input"
              type="text"
              placeholder={caps.chat ? `发消息给 ${agent.name}（prompt）…` : (caps.chatWhy ?? CONTRACT.chat)}
              aria-label="发送消息"
              value={draft}
              disabled={!caps.chat || commandBusy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.currentTarget.blur();
                if (event.key === "Enter" && !event.nativeEvent.isComposing && draft.trim()) {
                  event.preventDefault();
                  sendDraft(agent);
                }
              }}
            />
            <button className="btn small primary" type="button" disabled={!caps.chat || commandBusy || !draft.trim()} data-tip={caps.chatWhy ?? undefined} onClick={() => sendDraft(agent)}>
              <Icon name="message" extra="sm" />发送
            </button>
          </div>
          {agent.status === "parked" ? <div className="hub-cap-note"><Icon name="clock" extra="sm" />parked agent：发送将自动 revive（outcome=revived）</div> : null}
        </>
      );
    }
    if (tab === "jobs") return renderJobs(agent);
    if (tab === "messages") {
      return (
        <>
          <div className="hub-ro-banner" style={{ margin: "0 0 var(--sp-12)" }}><Icon name="lock" extra="sm" /><span>{CONTRACT.irc}</span></div>
          <div className="hub-irc-list"><EmptyBlock icon="message" detail={agent.unread > 0 ? `${agent.unread} 条未读（内容读取本轮未接入）` : "没有与该 Agent 的 IRC 往来"} /></div>
        </>
      );
    }
    return renderOverview(agent);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") searchRef.current?.blur();
  };

  const composerAgents = preview ? hubComposerAgents(mapped.roster) : (snapshot?.agents ?? []);

  return (
    <div className={`hub-page${chatOpen ? " is-chat-preview" : ""}${chatClosing ? " is-chat-closing" : ""}`} id="hubRoot">
      {connKind === "offline" ? (
        <div className="hub-conn red">
          <Icon name="alert" extra="sm" /><b>Runtime 离线</b>
          <span className="hc-detail">无法连接 OMP runtime。列表为最后一次已知状态；所有写操作已禁用。</span>
        </div>
      ) : null}
      {connKind === "reconnecting" ? (
        <div className="hub-conn amber">
          <span className="spinner" /><b>正在重连</b>
          <span className="hc-detail">与 runtime 的连接中断，正在重试… roster 为最后一次同步的快照。</span>
        </div>
      ) : null}
      {connKind === "resync" ? (
        <div className="hub-conn blue">
          <span className="spinner" /><b>状态回源中</b>
          <span className="hc-detail">正在恢复最新 Runtime 状态，敏感操作已暂停。</span>
        </div>
      ) : null}

      <div className="hub-main">
        <span className="hm-ic"><Icon name="message" /></span>
        <div className="hm-main">
          <div className="hm-title">{mainName}<span className="chip blue xs">{mainStatus}</span></div>
          <div className="hm-sub">
            <span className="hm-task ellipsis">{mainTask}</span>
            <span className="hm-meta mono">{mainMeta}</span>
            <span className="hm-meta mono hm-conn">
              {runtimeLabel}
              <span className={`hm-dot${connOnline ? " on" : ""}`} />
              {connOnline ? "已连接" : "未连接"} · 更新于 {fmtClock(now)}
            </span>
          </div>
        </div>
        <div className="hm-actions">
          <button className="btn small primary" type="button" onClick={onOpenMain}>
            <Icon name="external" extra="sm" />打开主对话
          </button>
        </div>
      </div>

      <div className="hub-roster-head">
        <div className="seg" role="group" aria-label="Roster 视图">
          <button type="button" className={view === "flat" ? "active" : undefined} onClick={() => setView("flat")}>Flat</button>
          <button type="button" className={view === "tree" ? "active" : undefined} onClick={() => setView("tree")}>By parent</button>
        </div>
        <div className="hub-status-counts">
          {(["running", "idle", "parked", "aborted"] as const).filter((key) => counts[key]).map((key) => (
            <span className="sc-item" key={key}><span className={`dot ${STATUS_DOT[key]}`} />{counts[key]} {STATUS_LABEL[key]}</span>
          ))}
        </div>
        <span className="spacer" />
        <input
          ref={searchRef}
          className="input hub-search"
          type="search"
          placeholder="搜索 id / 名称 / 任务 / 模型…"
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
          <button className="btn small primary" type="button" onClick={() => setModal({ kind: "spawn" })}>
            <Icon name="plus" extra="sm" />New Agent
          </button>
        </div>
      ) : null}

      <div className={`hub-cols${chatOpen ? " is-chat-preview" : ""}`} ref={colsRef}>
        <div className={`hub-list${view === "tree" ? " tree" : ""}`} id="hubList" ref={listRef} role="listbox" aria-label="子 Agent 列表">
          {renderList()}
        </div>
        {selectedAgent ? (
          <div className={`hub-detail${drawerOpen || !narrow ? " open" : ""}${chatOpen || chatClosing ? " is-chat" : ""}`} id="hubDetail">
            <div className="hub-face-stage" ref={stageRef}>
              {hubFaces.map((face) => {
                const role = tabPaneRole(face, incoming, outgoing, live);
                return (
                  <div
                    key={face}
                    className={hubFaceClass(role, dir)}
                    data-tab-pane={face}
                    data-hub-face={face}
                    {...(role === "leave" ? { "aria-hidden": true, inert: true } : {})}
                  >
                    {face === "chat" ? (
                      <>
                        <div className="hub-chat-bar">
                          <button className="btn small outline" type="button" onClick={() => setChatOpen(false)}>
                            <Icon name="arrow-l" extra="sm" />返回
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
                          composerId="hubAgentComposer"
                          autoFocusComposer
                          {...(preview ? { previewComposer: true } : {})}
                          {...(preview || workspaceId === undefined ? {} : { workspaceId })}
                          {...(preview || loadMentions === undefined ? {} : { loadMentions })}
                        />
                      </>
                    ) : (
                      <>
            <div className="hub-detail-head">
              <div className="hd-title">
                <button className="icon-btn small hub-drawer-back" type="button" data-tip="返回" onClick={() => setDrawerOpen(false)}>
                  <Icon name="arrow-l" extra="sm" />
                </button>
                <b>{selectedAgent.name}</b>
                <span className="mono tiny muted">{selectedAgent.id}</span>
                <span className={`chip ${selectedAgent.kind === "advisor" ? "gray" : "purple"} xs`}>{selectedAgent.kind}</span>
                {selectedAgent.parentId ? <span className="tiny muted">of {selectedAgent.parentId}</span> : null}
                <span className="spacer" />
                <span className={`hub-act ${activityPill(selectedAgent).cls}`}>{activityPill(selectedAgent).label}</span>
              </div>
              <div className="hd-sub">
                <span className="hub-status-line">
                  <span className={`dot ${STATUS_DOT[selectedAgent.status]}`} />
                  {STATUS_LABEL[selectedAgent.status]} · {selectedAgent.metrics ? fmtDur(selectedAgent.metrics.durationMs) : selectedAgent.startedAt ? fmtDur(now - selectedAgent.startedAt) : "—"} · active {fmtAge(selectedAgent.lastActivity, now)}
                </span>
                {selectedAgent.modelRole ? <span className="hub-role">{selectedAgent.modelRole}</span> : null}
                {selectedAgent.fallback ? <span className="hub-model hub-fallback">fallback → {selectedAgent.fallback}</span> : selectedAgent.resolvedModel ? <span className="hub-model">{selectedAgent.resolvedModel}</span> : null}
              </div>
            </div>
            <div className="hub-detail-actions">
              <button className="btn small primary" type="button" disabled={!caps.open} data-tip={caps.openWhy ?? undefined} onClick={() => openChat(selectedAgent.id)}>
                <Icon name="external" extra="sm" />打开
              </button>
              <button className="btn small outline" type="button" disabled={!caps.chat || commandBusy} data-tip={caps.chatWhy ?? undefined} onClick={() => openChat(selectedAgent.id)}>
                <Icon name="message" extra="sm" />发消息
              </button>
              <button
                className="btn small outline"
                type="button"
                disabled={!caps.revive || commandBusy}
                data-tip={caps.reviveWhy ?? undefined}
                onClick={() => reviveAgent(selectedAgent)}
              >
                <Icon name="refresh" extra="sm" />Revive
              </button>
              <button
                className="btn small danger"
                type="button"
                disabled={!caps.kill || commandBusy}
                data-tip={caps.killWhy ?? undefined}
                onClick={() => {
                  if (!caps.kill) warn(caps.killWhy ?? CONTRACT.kill);
                  else setModal({ kind: "kill", agentId: selectedAgent.id });
                }}
              >
                <Icon name="stop" extra="sm" />Kill
              </button>
              {selectedAgent.status === "aborted"
                ? (
                  <button
                    className="btn small outline"
                    type="button"
                    disabled={!caps.release || commandBusy}
                    data-tip={caps.releaseWhy ?? undefined}
                    onClick={() => releaseAgent(selectedAgent)}
                  >
                    <Icon name="x" extra="sm" />Release
                  </button>
                )
                : null}
            </div>
            <div className="hub-detail-tabs">
              <div className="tabs" role="tablist" aria-label="Agent 详情" id="hubTabs">
                {TABS.map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    className={tab === id ? "active" : undefined}
                    aria-selected={tab === id}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => { setTab(id); setNotice(null); }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="hub-detail-body" id="hubDetailBody">
              {notice ? (
                <div className={`hub-notice ${notice.kind}`}>
                  <Icon name={notice.kind === "ok" ? "check" : "alert"} extra="sm" /><span>{notice.text}</span>
                </div>
              ) : null}
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

      {modal ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setModal(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={modal.kind === "spawn" ? "New Agent" : "Kill Agent"} onMouseDown={(event) => event.stopPropagation()}>
            {modal.kind === "spawn" ? (
              <>
                <div className="modal-head">
                  <b>New Agent</b>
                  <button className="icon-btn small" type="button" data-tip="关闭" onClick={() => setModal(null)}><Icon name="x" extra="sm" /></button>
                </div>
                <div className="modal-body">
                  <div className="hub-na-grid">
                    <div className="hub-na-row">
                      <div className="field">
                        <label className="tiny muted" htmlFor="naTask">任务描述</label>
                        <textarea
                          className="input"
                          id="naTask"
                          rows={3}
                          placeholder="例如：审计 pi-core 0.82.1 的 breaking changes…"
                          value={spawnTask}
                          onChange={(event) => setSpawnTask(event.target.value)}
                          disabled={preview || commandBusy || connOnline === false || client === undefined || missingCap(capabilities, "agent.spawn")}
                        />
                      </div>
                    </div>
                    <div className="hub-na-row">
                      <div className="field">
                        <label className="tiny muted" htmlFor="naRole">Agent 定义</label>
                        <select
                          className="select"
                          id="naRole"
                          value={spawnDefinition}
                          onChange={(event) => setSpawnDefinition(event.target.value)}
                          disabled={preview || commandBusy || spawnDefinitions === null || spawnDefinitions.length === 0}
                        >
                          {spawnDefinitions === null
                            ? <option value="">读取定义中…</option>
                            : spawnDefinitions.length === 0
                              ? <option value="">无可用定义（fallback: general-purpose）</option>
                              : spawnDefinitions.map((definition) => (
                                <option key={definition.name} value={definition.name}>{definition.name}{definition.description ? ` — ${definition.description.slice(0, 60)}` : ""}</option>
                              ))}
                        </select>
                      </div>
                      <div className="field">
                        <label className="tiny muted" htmlFor="naCount">并发数量</label>
                        <select className="select" id="naCount" disabled><option>1</option></select>
                      </div>
                    </div>
                    <div className="tiny muted">
                      {preview
                        ? "预览模式不调用 Host 写操作。"
                        : missingCap(capabilities, "agent.spawn")
                          ? `${CONTRACT.spawn}。`
                          : "对齐 OMP：spawn 即注册 registry（status=running→starting），父级为当前主 Agent；async 任务返回 jobId。"}
                    </div>
                  </div>
                </div>
                <div className="modal-foot">
                  <button className="btn outline" type="button" onClick={() => setModal(null)}>取消</button>
                  <button
                    className="btn primary"
                    type="button"
                    disabled={preview || commandBusy || !spawnTask.trim() || !spawnDefinition || connOnline === false || client === undefined || missingCap(capabilities, "agent.spawn")}
                    data-tip={missingCap(capabilities, "agent.spawn") ? CONTRACT.spawn : undefined}
                    onClick={() => {
                      const definition = spawnDefinition.trim();
                      if (!(spawnDefinitions ?? []).some((item) => item.name === definition)) {
                        setNotice({ kind: "warn", text: "没有可用的 Agent 定义" });
                        return;
                      }
                      void runCommand("agent.spawn", { definition, assignment: spawnTask.trim(), async: true }, `Spawn（${definition}）已提交`).then((ok) => {
                        if (ok) {
                          setModal(null);
                          setSpawnTask("");
                        }
                      });
                    }}
                  >
                    Spawn
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head">
                  <b>Kill {killTarget?.name ?? modal.agentId}？</b>
                  <button className="icon-btn small" type="button" data-tip="关闭" onClick={() => setModal(null)}><Icon name="x" extra="sm" /></button>
                </div>
                <div className="modal-body">
                  <div className="small" style={{ color: "var(--text-2)", lineHeight: 1.6 }}>
                    将执行 OMP 的 kill 流程：<b>abort</b> 当前 turn，然后释放 registry 引用并写入
                    <span className="mono"> tombstone</span> 边车文件。agent 进入终态 <b>aborted</b>：
                    保留在列表中可查 transcript，但<b>不可 revive</b>。
                    <div style={{ marginTop: 8 }}>提交后 Runtime 会弹出 <b>destructive 确认卡</b>（底部 InteractionDeck），在其中确认后 kill 才会执行。</div>
                    {killCaps.killWhy ? <div style={{ marginTop: 8 }}>{killCaps.killWhy}</div> : null}
                  </div>
                </div>
                <div className="modal-foot">
                  <button className="btn outline" type="button" onClick={() => setModal(null)}>取消</button>
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
                    提交 Kill（abort + tombstone）
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


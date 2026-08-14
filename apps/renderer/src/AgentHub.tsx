import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { ClientBootstrap } from "@omp-studio/client-contract";
import type { OperatorStateSnapshot, StudioAgentSnapshot, StudioJobSnapshot } from "@omp-studio/studio-protocol";
import { Icon } from "./icons";
import { buildPreviewHub } from "./hubPreview";
import type { PreviewAgent, PreviewJob, PreviewMetrics } from "./hubPreview";
import { usePreviewMode } from "./preview/PreviewContext";

export const HUB_INTENT_KEY = "omp.hubIntent";
const HUB_STATE_KEY = "omp.agentHub.state";

export type HubTab = "overview" | "transcript" | "jobs" | "messages";
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
  chat: "agent.send 不在公共 client command contract 中",
  revive: "agent.revive 不在公共 client command contract 中",
  kill: "agent.kill 不在公共 client command contract 中",
  spawn: "agent.spawn 不在公共 client command contract 中",
  cancel: "job.cancel 不在公共 client command contract 中",
  transcript: "公共 Host contract 不暴露 Agent transcript read model",
  irc: "hub IRC 不在公共 contract 中",
} as const;

export function setHubIntent(agentId: string, tab?: HubTab): void {
  try {
    sessionStorage.setItem(HUB_INTENT_KEY, JSON.stringify({ agentId, tab: tab ?? null }));
  } catch {
    /* sessionStorage may be blocked; navigation still opens the hub. */
  }
}

function loadPersisted(): Persisted {
  try {
    const saved = JSON.parse(localStorage.getItem(HUB_STATE_KEY) || "{}") as Partial<Persisted>;
    return {
      selected: typeof saved.selected === "string" ? saved.selected : null,
      tab: saved.tab === "transcript" || saved.tab === "jobs" || saved.tab === "messages" ? saved.tab : "overview",
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

function takeIntent(): { agentId?: string; tab?: HubTab } | null {
  try {
    const raw = sessionStorage.getItem(HUB_INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HUB_INTENT_KEY);
    return JSON.parse(raw) as { agentId?: string; tab?: HubTab };
  } catch {
    return null;
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
  const d = new Date(ts);
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
  return {
    id: agent.agentId,
    name: agent.displayName,
    kind: agent.kind,
    ...(agent.parentAgentId ? { parentId: agent.parentAgentId } : {}),
    status: hubStatus(agent.status),
    rawStatus: agent.status,
    task: agent.assignment ?? agent.summary ?? "—",
    readOnly: agent.kind === "advisor",
    unread: agent.unreadCount,
    children,
    ...(Number.isFinite(parseTs(agent.startedAt)) ? { startedAt: parseTs(agent.startedAt) } : {}),
    lastActivity: Number.isFinite(parseTs(agent.updatedAt)) ? parseTs(agent.updatedAt) : Date.now(),
    hasLiveSession: agent.hasLiveSession,
    hasTranscript: agent.hasTranscript,
    generation: agent.generation,
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

function capsFor(
  agent: HubAgent | undefined,
  connOnline: boolean,
  capabilities: ClientBootstrap["capabilityManifest"] | undefined,
): Caps {
  if (!agent) {
    return {
      open: false, openWhy: null, chat: false, chatWhy: null,
      revive: false, reviveWhy: null, kill: false, killWhy: null,
    };
  }
  const dead = agent.status === "aborted";
  const advisor = isAdvisor(agent);
  const noFile = !agent.hasLiveSession;
  const chatMissing = missingCap(capabilities, "agent.send");
  const reviveMissing = missingCap(capabilities, "agent.revive");
  return {
    open: !dead,
    openWhy: dead ? "aborted 为终态" : null,
    chat: false,
    chatWhy: advisor ? "advisor 是只读观察记录" : dead ? "aborted 为终态" : noFile ? "暂无 live session" : !connOnline ? "runtime 未连接" : chatMissing ? "Limited Runtime 未协商 agent.send" : CONTRACT.chat,
    revive: false,
    reviveWhy: advisor ? "advisor 只读" : agent.status !== "parked" ? "仅 parked 可 revive" : !connOnline ? "runtime 未连接" : reviveMissing ? "Limited Runtime 未协商 agent.revive" : CONTRACT.revive,
    kill: false,
    killWhy: advisor ? "advisor 只读" : dead ? "已是终态" : !connOnline ? "runtime 未连接" : missingCap(capabilities, "agent.kill") ? "Limited Runtime 未协商 agent.kill" : CONTRACT.kill,
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
      {agent.unread > 0 ? <span className="hub-unread" data-tip={`${agent.unread} 条未读消息`}><Icon name="message" extra="sm" />{agent.unread}</span> : null}
      {agent.readOnly ? <span className="hub-ro-tag">read-only</span> : null}
      {kids ? <span className="hub-ro-tag" data-tip={`子 Agent：${agent.children.join("、")}`}>↳ {kids} 子</span> : null}
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
        {agent.startedAt ? <span className="hc-start" data-tip={`运行开始时刻 · 已运行 ${fmtDur(metrics?.durationMs ?? (Date.now() - agent.startedAt))}`}><Icon name="clock" extra="sm" />{fmtHM(agent.startedAt)}</span> : null}
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
  onOpenMain,
}: {
  snapshot?: OperatorStateSnapshot;
  runtime?: ClientBootstrap["runtime"];
  resyncRequired?: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"];
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
  const [modal, setModal] = useState<Modal | null>(null);
  const [now, setNow] = useState(Date.now());
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth <= 900);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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
    return {
      preview: false,
      roster,
      jobs: (snapshot?.jobs ?? []).map(toHubJob),
      mainName: main?.name ?? "主对话",
      mainStatus: snapshot?.isStreaming ? "Streaming" : snapshot?.activeMode ?? "idle",
      mainTask: main?.task ?? (snapshot ? `session ${snapshot.sessionId}` : "等待 Runtime snapshot"),
      mainMeta: snapshot ? `${snapshot.activeMode} · pending ${snapshot.pendingMessages} · agents ${roster.length}` : "usage —",
      runtimeLabel: undefined as string | undefined,
    };
  }, [preview, snapshot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mapped.roster;
    return mapped.roster.filter((agent) => `${agent.name} ${agent.id} ${agent.task} ${agent.kind} ${agent.modelRole ?? ""} ${agent.resolvedModel ?? ""}`.toLowerCase().includes(q));
  }, [mapped.roster, query]);

  const selectedAgent = filtered.find((agent) => agent.id === selected) ?? undefined;
  const caps = capsFor(selectedAgent, connOnline, capabilities);

  const select = useCallback((id: string, opts?: { scroll?: boolean }) => {
    setSelected(id);
    setNotice(null);
    if (typeof window !== "undefined" && window.innerWidth <= 900) setDrawerOpen(true);
    if (opts?.scroll) {
      requestAnimationFrame(() => {
        const row = listRef.current?.querySelector(`[data-hub-id="${CSS.escape(id)}"]`);
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }, []);

  useEffect(() => {
    const intent = takeIntent();
    if (!intent?.agentId) return;
    if (intent.tab) setTab(intent.tab);
    if (mapped.roster.some((agent) => agent.id === intent.agentId)) select(intent.agentId, { scroll: true });
  }, [mapped.roster, select]);

  const openChat = (id: string) => {
    setTab("transcript");
    select(id);
  };

  const warn = (text: string) => setNotice({ kind: "warn", text });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = Boolean(target?.closest("input, textarea, select"));
      if (inField) return;
      if (document.querySelector(".modal-backdrop")) return;
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
          if (selected) {
            event.preventDefault();
            openChat(selected);
          }
          break;
        case "t":
          event.preventDefault();
          setView((current) => current === "flat" ? "tree" : "flat");
          break;
        case "r":
          if (selectedAgent) {
            event.preventDefault();
            warn(caps.reviveWhy ?? CONTRACT.revive);
          }
          break;
        case "x":
          if (selectedAgent) {
            event.preventDefault();
            if (selectedAgent.status === "aborted" || isAdvisor(selectedAgent)) warn(caps.killWhy ?? CONTRACT.kill);
            else setModal({ kind: "kill", agentId: selectedAgent.id });
          }
          break;
        case "Escape":
          if (drawerOpen) setDrawerOpen(false);
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [caps.killWhy, caps.reviveWhy, drawerOpen, filtered, select, selected, selectedAgent, view]);

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
    const ctxPct = metrics?.contextWindow ? Math.round((metrics.contextTokens ?? 0) / metrics.contextWindow * 100) : null;
    const currentEmpty = !agent.currentTool && !agent.lastIntent && !agent.retryState;
    return (
      <>
        <div className="hub-sec-title">Task</div>
        <div className="hub-kv"><Kv label="Task">{agent.task}</Kv></div>
        <div className="hub-sec-title">Current</div>
        <div className="hub-kv">
          {agent.currentTool ? <Kv label="Tool"><span className="chip blue xs">{agent.currentTool.name}</span>{agent.currentTool.args ? ` ${agent.currentTool.args}` : ""}</Kv> : null}
          {agent.lastIntent ? <Kv label="Last intent">{agent.lastIntent}</Kv> : null}
          {agent.retryState ? <Kv label="Retry"><span style={{ color: "var(--amber)" }}>retry {agent.retryState.attempt}/{agent.retryState.maxAttempts}</span>{agent.retryState.errorMessage ? ` · ${agent.retryState.errorMessage}` : ""}</Kv> : null}
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
          <Icon name="lock" extra="sm" />{missingCap(capabilities, "job.cancel") ? "job.cancel 未协商：取消操作不可用（owner-scoped）" : CONTRACT.cancel}
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
                ? <button className="btn small outline" type="button" disabled data-tip={CONTRACT.cancel}>取消</button>
                : null}
            </div>
          ))
          : <EmptyBlock icon="terminal" detail={`没有${jobsTab === "mine" ? "该 Agent 的" : ""} job`} />}
      </>
    );
  };

  const renderDetailBody = (agent: HubAgent) => {
    if (tab === "transcript") {
      return (
        <>
          <div className="hub-transcript" id="hubTranscript">
            <EmptyBlock icon="message" detail={agent.hasTranscript ? CONTRACT.transcript : "No messages yet."} />
          </div>
          <div className="hub-ro-banner"><Icon name="lock" extra="sm" /><span>{caps.chatWhy ?? CONTRACT.chat}</span></div>
        </>
      );
    }
    if (tab === "jobs") return renderJobs(agent);
    if (tab === "messages") {
      return (
        <>
          <div className="hub-ro-banner" style={{ margin: "0 0 var(--sp-12)" }}><Icon name="lock" extra="sm" /><span>{CONTRACT.irc}</span></div>
          <div className="hub-irc-list"><EmptyBlock icon="message" detail="没有与该 Agent 的 IRC 往来" /></div>
        </>
      );
    }
    return renderOverview(agent);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") searchRef.current?.blur();
  };

  return (
    <div className="hub-page" id="hubRoot">
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

      <div className="hub-cols">
        <div className={`hub-list${view === "tree" ? " tree" : ""}`} id="hubList" ref={listRef} role="listbox" aria-label="子 Agent 列表">
          {renderList()}
        </div>
        {selectedAgent ? (
          <div className={`hub-detail${drawerOpen || !narrow ? " open" : ""}`} id="hubDetail">
            <div className="hub-detail-head">
              <div className="hd-title">
                <button className="icon-btn small hub-drawer-back" type="button" data-tip="返回列表" onClick={() => setDrawerOpen(false)}>
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
              <button className="btn small outline" type="button" disabled data-tip={caps.chatWhy ?? CONTRACT.chat}>
                <Icon name="message" extra="sm" />发消息
              </button>
              <button className="btn small outline" type="button" disabled data-tip={caps.reviveWhy ?? CONTRACT.revive}>
                <Icon name="refresh" extra="sm" />Revive
              </button>
              <button
                className="btn small danger"
                type="button"
                disabled={Boolean(caps.killWhy && (selectedAgent.status === "aborted" || isAdvisor(selectedAgent)))}
                data-tip={caps.killWhy ?? CONTRACT.kill}
                onClick={() => {
                  if (selectedAgent.status === "aborted" || isAdvisor(selectedAgent)) warn(caps.killWhy ?? CONTRACT.kill);
                  else setModal({ kind: "kill", agentId: selectedAgent.id });
                }}
              >
                <Icon name="stop" extra="sm" />Kill
              </button>
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
                <div className="hub-notice" style={{ background: `var(--${notice.kind === "ok" ? "green" : notice.kind === "warn" ? "amber" : "red"}-soft)`, color: `var(--${notice.kind === "ok" ? "green" : notice.kind === "warn" ? "amber" : "red"})` }}>
                  <Icon name={notice.kind === "ok" ? "check" : "alert"} extra="sm" /><span>{notice.text}</span>
                </div>
              ) : null}
              {renderDetailBody(selectedAgent)}
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
                        <textarea className="input" id="naTask" rows={3} placeholder="例如：审计 pi-core 0.82.1 的 breaking changes…" disabled />
                      </div>
                    </div>
                    <div className="hub-na-row">
                      <div className="field">
                        <label className="tiny muted" htmlFor="naRole">Model role</label>
                        <select className="select" id="naRole" disabled><option>@smol</option></select>
                      </div>
                      <div className="field">
                        <label className="tiny muted" htmlFor="naCount">并发数量</label>
                        <select className="select" id="naCount" disabled><option>1</option></select>
                      </div>
                    </div>
                    <div className="tiny muted">{CONTRACT.spawn}。对齐 OMP：spawn 即注册 registry（status=running），父级为当前主 Agent。</div>
                  </div>
                </div>
                <div className="modal-foot">
                  <button className="btn outline" type="button" onClick={() => setModal(null)}>取消</button>
                  <button className="btn primary" type="button" disabled data-tip={CONTRACT.spawn}>Spawn</button>
                </div>
              </>
            ) : (
              <>
                <div className="modal-head">
                  <b>Kill {selectedAgent?.name ?? modal.agentId}？</b>
                  <button className="icon-btn small" type="button" data-tip="关闭" onClick={() => setModal(null)}><Icon name="x" extra="sm" /></button>
                </div>
                <div className="modal-body">
                  <div className="small" style={{ color: "var(--text-2)", lineHeight: 1.6 }}>
                    将执行 OMP 的 kill 流程：<b>abort</b> 当前 turn，然后释放 registry 引用并写入
                    <span className="mono"> tombstone</span> 边车文件。agent 进入终态 <b>aborted</b>：
                    保留在列表中可查 transcript，但<b>不可 revive</b>。
                    <div style={{ marginTop: 8 }}>{CONTRACT.kill}。</div>
                  </div>
                </div>
                <div className="modal-foot">
                  <button className="btn outline" type="button" onClick={() => setModal(null)}>取消</button>
                  <button className="btn danger solid" type="button" disabled data-tip={CONTRACT.kill}>Kill（abort + tombstone）</button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}


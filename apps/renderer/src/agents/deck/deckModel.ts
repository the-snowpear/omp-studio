import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { agentRosterRows } from "../AgentRosterPanel";
import { agentPresentation } from "../agentPresentation";
import { sigilHue } from "./sigil";

/**
 * What the deck draws for one agent. Everything is derived from the snapshot the
 * Host pushed (plus, in preview, the demo adapter); nothing here is invented.
 * `waiting` only ever comes from the preview adapter: Runtime lifecycle alone
 * cannot tie a pending interaction to an individual child agent.
 */
export type DeckTone = "running" | "waiting" | "failed" | "idle" | "parked" | "stopped";
/** The four groups the status ribbon, the filter and the meter agree on. */
export type DeckGroup = "running" | "waiting" | "failed" | "settled";

export type DeckAgent = {
  readonly id: string;
  readonly agent: StudioAgentSnapshot;
  readonly name: string;
  readonly main: boolean;
  readonly depth: number;
  readonly parentId?: string;
  readonly childIds: readonly string[];
  /** Position in the stable parent-first order; lifecycle updates never change it. */
  readonly order: number;
  readonly tone: DeckTone;
  readonly group: DeckGroup;
  readonly statusText: string;
  readonly model?: string;
  readonly modelLabel: string;
  readonly fallback: boolean;
  readonly role?: string;
  readonly task?: string;
  readonly stage?: string;
  /** 0–1: the task's own estimate, else delivered prompt groups of a stepped task. */
  readonly progress?: number;
  readonly steps?: { readonly total: number; readonly sent: number; readonly completed: number };
  readonly tokens?: number;
  readonly cost?: number;
  readonly tools?: number;
  readonly requests?: number;
  readonly tps?: number;
  readonly context?: { readonly used: number; readonly window: number };
  readonly startedAt?: number;
  readonly updatedAt: number;
  readonly hue: number;
  readonly unread: number;
};

export type DeckTotals = {
  readonly agents: number;
  readonly children: number;
  readonly groups: Readonly<Record<DeckGroup, number>>;
  readonly tokens: number | undefined;
  readonly cost: number | undefined;
  readonly tools: number | undefined;
  readonly tps: number | undefined;
  readonly startedAt?: number;
};

const TONE_GROUP: Record<DeckTone, DeckGroup> = { running: "running", waiting: "waiting", failed: "failed", idle: "settled", parked: "settled", stopped: "settled" };

export function deckTone(status: StudioAgentSnapshot["status"], demoTone?: string): DeckTone {
  if (demoTone === "waiting") return "waiting";
  if (demoTone === "failed") return "failed";
  switch (status) {
    case "starting": case "running": case "reviving": return "running";
    case "failed": return "failed";
    case "idle": return "idle";
    case "parked": return "parked";
    default: return "stopped";
  }
}

/** A tone whose bar has ended: the agent is not working any more. */
export function toneSettled(tone: DeckTone): boolean {
  return tone !== "running" && tone !== "waiting";
}

function time(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildDeck(agents: readonly StudioAgentSnapshot[], preview: boolean, zh: boolean): DeckAgent[] {
  const rows = agentRosterRows(agents);
  const children = new Map<string, string[]>();
  const known = new Set(agents.map(agent => String(agent.agentId)));
  for (const { agent } of rows) {
    const parent = agent.parentAgentId !== undefined && known.has(agent.parentAgentId) ? String(agent.parentAgentId) : undefined;
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(agent.agentId);
    children.set(parent, list);
  }
  return rows.map(({ agent, depth }, order) => {
    const presentation = agentPresentation(agent, preview, zh);
    const tone = deckTone(agent.status, presentation.demo?.tone);
    const steps = agent.taskSteps && agent.taskSteps.prompts.length > 0
      ? { total: agent.taskSteps.prompts.length, sent: agent.taskSteps.sent, completed: agent.taskSteps.completed }
      : undefined;
    const progress = agent.completionPercent !== undefined
      ? Math.max(0, Math.min(1, agent.completionPercent / 100))
      : steps ? steps.completed / steps.total : undefined;
    const usage = agent.usage;
    const parentId = agent.parentAgentId !== undefined && known.has(agent.parentAgentId) ? String(agent.parentAgentId) : undefined;
    const startedAt = time(agent.startedAt);
    const stage = agent.stage ?? agent.summary;
    return {
      id: agent.agentId,
      agent,
      name: agent.displayName,
      main: agent.kind === "main",
      depth,
      ...(parentId === undefined ? {} : { parentId }),
      childIds: children.get(agent.agentId) ?? [],
      order,
      tone,
      group: TONE_GROUP[tone],
      statusText: presentation.status,
      ...(presentation.model === undefined ? {} : { model: presentation.model }),
      modelLabel: presentation.modelLabel,
      fallback: agent.modelIsFallback === true,
      ...(agent.modelRole === undefined ? {} : { role: agent.modelRole }),
      ...(agent.assignment === undefined ? {} : { task: agent.assignment }),
      ...(stage === undefined || stage === "" ? {} : { stage }),
      ...(progress === undefined ? {} : { progress }),
      ...(steps === undefined ? {} : { steps }),
      ...(usage === undefined ? {} : { tokens: usage.tokens, cost: usage.cost, tools: usage.tools, requests: usage.requests }),
      ...(usage?.generationTps === undefined ? {} : { tps: usage.generationTps }),
      ...(usage?.contextTokens !== undefined && usage.contextWindow ? { context: { used: usage.contextTokens, window: usage.contextWindow } } : {}),
      ...(startedAt === undefined ? {} : { startedAt }),
      updatedAt: time(agent.updatedAt) ?? Date.now(),
      // Identity comes from the id alone: switching language must not repaint an agent's face.
      hue: agent.kind === "main" ? -1 : sigilHue(agent.agentId),
      unread: agent.unreadCount,
    };
  });
}

export function deckTotals(rows: readonly DeckAgent[], historical = false): DeckTotals {
  const groups: Record<DeckGroup, number> = { running: 0, waiting: 0, failed: 0, settled: 0 };
  let tokens = 0, cost = 0, tools = 0, tps = 0, startedAt: number | undefined;
  for (const row of rows) {
    if (!row.main) groups[row.group] += 1;
    tokens += row.tokens ?? 0;
    cost += row.cost ?? 0;
    tools += row.tools ?? 0;
    if (row.tone === "running") tps += row.tps ?? 0;
    if (row.startedAt !== undefined) startedAt = startedAt === undefined ? row.startedAt : Math.min(startedAt, row.startedAt);
  }
  return { agents: rows.length, children: rows.filter(row => !row.main).length, groups,
    tokens: historical && rows.some(row => row.tokens === undefined) ? undefined : tokens,
    cost: historical && rows.some(row => row.cost === undefined) ? undefined : cost,
    tools: historical && rows.some(row => row.tools === undefined) ? undefined : tools,
    tps: historical && rows.some(row => row.tone === "running" && row.tps === undefined) ? undefined : tps,
    ...(startedAt === undefined ? {} : { startedAt }) };
}

export type DeckFilter = { readonly query: string; readonly groups: ReadonlySet<DeckGroup> };

/** Search reaches name, task, stage and model; a match keeps its ancestors so the tree stays readable. */
export function filterDeck(rows: readonly DeckAgent[], filter: DeckFilter): { visible: ReadonlySet<string>; matched: ReadonlySet<string> } {
  const query = filter.query.trim().toLowerCase();
  const matched = new Set<string>();
  for (const row of rows) {
    const groupOk = filter.groups.size === 0 || row.main || filter.groups.has(row.group);
    const text = `${row.name}\n${row.task ?? ""}\n${row.stage ?? ""}\n${row.model ?? ""}\n${row.role ?? ""}`.toLowerCase();
    if (groupOk && (query === "" || text.includes(query))) matched.add(row.id);
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  const visible = new Set<string>();
  for (const id of matched) {
    let row = byId.get(id);
    while (row) {
      visible.add(row.id);
      row = row.parentId === undefined ? undefined : byId.get(row.parentId);
    }
  }
  return { visible, matched };
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "—";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(count));
}

export function formatCost(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0";
  if (cost < 0.01) return "<$0.01";
  if (cost < 100) return `$${cost.toFixed(2)}`;
  return `$${Math.round(cost)}`;
}

/** `m:ss` under an hour, `h:mm:ss` above: tabular, so a ticking clock never jitters. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatTps(tps: number): string {
  return tps >= 100 ? String(Math.round(tps)) : tps.toFixed(tps >= 10 ? 0 : 1);
}

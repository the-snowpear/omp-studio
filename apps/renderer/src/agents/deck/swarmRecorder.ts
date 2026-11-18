import { useSyncExternalStore } from "react";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";

/**
 * The Host pushes only the latest snapshot of each agent, so the deck keeps its
 * own short memory of what it saw happen: snapshots with status, stage and usage, and the
 * swarm's generation rate once a second. It lives for this renderer run only,
 * keyed by the same scope as the agent tabs (target, workspace, parent session,
 * preview), and is bounded so a long session cannot grow it without limit.
 */

export type SwarmMark = {
  readonly at: number;
  readonly status: StudioAgentSnapshot["status"];
  readonly stage?: string;
  readonly snapshot: StudioAgentSnapshot;
  /** Lifecycle, generation or stage changed; retain these before periodic usage observations. */
  readonly transition: boolean;
};
export type SwarmSample = { readonly at: number; readonly tps: number; readonly running: number };

type LastSeen = {
  readonly status: StudioAgentSnapshot["status"];
  readonly stage: string | undefined;
  readonly updatedAt: string;
  readonly generation: StudioAgentSnapshot["generation"];
  readonly usage: StudioAgentSnapshot["usage"];
};

type Book = {
  firstSeen: Map<string, number>;
  marks: Map<string, SwarmMark[]>;
  last: Map<string, LastSeen>;
  samples: SwarmSample[];
  total: number;
  version: number;
  listeners: Set<() => void>;
};

const PER_AGENT = 200;
const TOTAL = 2000;
const SAMPLES = 90;
const MAX_BOOKS = 32;
const MAX_TEXT_CHARS = 1024;
const books = new Map<string, Book>();

function clampString(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/** Retain only lightweight fields needed by replay (`buildDeck` / `AgentInspector`), stripping prompt bodies. */
function compactSnapshot(agent: StudioAgentSnapshot): StudioAgentSnapshot {
  const { taskSteps, nestedPatchPaths: _nested, activeJobIds: _jobs, assignment, summary, ...rest } = agent;
  return {
    ...rest,
    activeJobIds: [],
    ...(assignment === undefined ? {} : { assignment: clampString(assignment) }),
    ...(summary === undefined ? {} : { summary: clampString(summary) }),
    ...(taskSteps === undefined
      ? {}
      : {
          taskSteps: {
            prompts: Array.from({ length: taskSteps.prompts.length }, () => ""),
            sent: taskSteps.sent,
            completed: taskSteps.completed,
            phase: taskSteps.phase,
            ...(taskSteps.reason === undefined ? {} : { reason: clampString(taskSteps.reason) }),
          },
        }),
  };
}

function book(scope: string): Book {
  const existing = books.get(scope);
  if (existing) {
    books.delete(scope);
    books.set(scope, existing);
    return existing;
  }
  if (books.size >= MAX_BOOKS) {
    let victim: string | undefined;
    for (const [key, candidate] of books) {
      if (candidate.listeners.size === 0) {
        victim = key;
        break;
      }
    }
    books.delete(victim ?? books.keys().next().value!);
  }
  const entry: Book = { firstSeen: new Map(), marks: new Map(), last: new Map(), samples: [], total: 0, version: 0, listeners: new Set() };
  books.set(scope, entry);
  return entry;
}

function bump(entry: Book) {
  entry.version += 1;
  for (const listener of entry.listeners) listener();
}

/** Diff one pushed roster against what this scope saw last; returns whether anything was recorded. */
export function recordSwarm(scope: string, agents: readonly StudioAgentSnapshot[], now = Date.now()): boolean {
  const entry = book(scope);
  let changed = false;
  for (const agent of agents) {
    if (!entry.firstSeen.has(agent.agentId)) { entry.firstSeen.set(agent.agentId, now); changed = true; }
    const stage = agent.stage ?? agent.summary;
    const previous = entry.last.get(agent.agentId);
    const transition = !previous || previous.status !== agent.status || previous.stage !== stage || previous.generation !== agent.generation;
    if (previous && previous.status === agent.status && previous.stage === stage
      && previous.updatedAt === agent.updatedAt && previous.generation === agent.generation && previous.usage === agent.usage) continue;
    const list = entry.marks.get(agent.agentId) ?? [];
    if (!transition && list.length > 0 && now - list[list.length - 1]!.at < 1000) continue;
    entry.last.set(agent.agentId, {
      status: agent.status,
      stage,
      updatedAt: agent.updatedAt,
      generation: agent.generation,
      usage: agent.usage,
    });
    list.push({
      at: now,
      status: agent.status,
      snapshot: compactSnapshot(agent),
      transition,
      ...(stage === undefined ? {} : { stage: clampString(stage) }),
    });
    entry.total += 1;
    if (list.length > PER_AGENT) {
      const usage = list.findIndex((mark, index) => !mark.transition && index < list.length - 1);
      list.splice(Math.max(0, usage), 1);
      entry.total -= 1;
    }
    entry.marks.set(agent.agentId, list);
    changed = true;
  }
  if (entry.total > TOTAL) {
    // Tier 1: trim non-tail marks (periodic usage first, then older transitions), keeping each agent's latest.
    const nonTail: Array<{ id: string; mark: SwarmMark }> = [];
    for (const [id, list] of entry.marks) {
      for (let i = 0; i < list.length - 1; i += 1) {
        nonTail.push({ id, mark: list[i]! });
      }
    }
    if (nonTail.length > 0) {
      nonTail.sort((a, b) => Number(a.mark.transition) - Number(b.mark.transition) || a.mark.at - b.mark.at);
      const dropCount = Math.min(nonTail.length, entry.total - TOTAL);
      const byAgent = new Map<string, Set<SwarmMark>>();
      for (let i = 0; i < dropCount; i += 1) {
        const { id, mark } = nonTail[i]!;
        let set = byAgent.get(id);
        if (!set) {
          set = new Set();
          byAgent.set(id, set);
        }
        set.add(mark);
      }
      for (const [id, dropped] of byAgent) {
        const list = entry.marks.get(id);
        if (!list) continue;
        const filtered = list.filter(mark => !dropped.has(mark));
        entry.total -= list.length - filtered.length;
        entry.marks.set(id, filtered);
      }
    }
    // Tier 2: if > TOTAL single-mark agents remain, evict oldest terminal/inactive subagents completely.
    if (entry.total > TOTAL) {
      const activeIds = new Set<string>();
      for (const agent of agents) {
        if (agent.status === "running" || agent.status === "starting" || agent.status === "reviving") {
          activeIds.add(agent.agentId);
        }
      }
      const singles: Array<{ id: string; at: number; active: boolean }> = [];
      for (const [id, list] of entry.marks) {
        if (list.length !== 1) continue;
        const only = list[0]!;
        if (only.snapshot.kind === "main") continue;
        const isTerminal =
          only.status !== "running" && only.status !== "starting" && only.status !== "reviving";
        singles.push({
          id,
          at: only.at,
          active: activeIds.has(id) || !isTerminal,
        });
      }
      singles.sort((a, b) => Number(a.active) - Number(b.active) || a.at - b.at);
      const evictCount = Math.min(singles.length, entry.total - TOTAL);
      for (let i = 0; i < evictCount; i += 1) {
        const { id } = singles[i]!;
        entry.marks.delete(id);
        entry.last.delete(id);
        entry.firstSeen.delete(id);
        entry.total -= 1;
      }
    }
  }
  if (changed) bump(entry);
  return changed;
}

export function sampleSwarm(scope: string, agents: readonly StudioAgentSnapshot[], now = Date.now()) {
  const entry = book(scope);
  let tps = 0, running = 0;
  for (const agent of agents) {
    if (agent.status !== "running" && agent.status !== "starting" && agent.status !== "reviving") continue;
    running += 1;
    tps += agent.usage?.generationTps ?? 0;
  }
  entry.samples.push({ at: now, tps, running });
  if (entry.samples.length > SAMPLES) entry.samples.shift();
  bump(entry);
}

export type SwarmMemory = {
  readonly version: number;
  readonly firstSeen: ReadonlyMap<string, number>;
  readonly marks: ReadonlyMap<string, readonly SwarmMark[]>;
  readonly samples: readonly SwarmSample[];
};

export function readSwarm(scope: string): SwarmMemory {
  const entry = book(scope);
  return { version: entry.version, firstSeen: entry.firstSeen, marks: entry.marks, samples: entry.samples };
}

const NO_SUBSCRIBE = () => () => undefined;

/** Re-renders on new memory only while `live`; a hidden deck reads the latest value when it shows again. */
export function useSwarmMemory(scope: string, live: boolean): SwarmMemory {
  const entry = book(scope);
  useSyncExternalStore(
    live ? (listener: () => void) => { entry.listeners.add(listener); return () => { entry.listeners.delete(listener); }; } : NO_SUBSCRIBE,
    () => entry.version,
  );
  return readSwarm(scope);
}

export function __resetSwarmForTests() {
  books.clear();
}

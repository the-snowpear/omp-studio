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

type Book = {
  firstSeen: Map<string, number>;
  marks: Map<string, SwarmMark[]>;
  last: Map<string, StudioAgentSnapshot>;
  samples: SwarmSample[];
  total: number;
  version: number;
  listeners: Set<() => void>;
};

const PER_AGENT = 200;
const TOTAL = 2000;
const SAMPLES = 90;
const books = new Map<string, Book>();

function book(scope: string): Book {
  let entry = books.get(scope);
  if (!entry) {
    entry = { firstSeen: new Map(), marks: new Map(), last: new Map(), samples: [], total: 0, version: 0, listeners: new Set() };
    books.set(scope, entry);
  }
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
    const transition = !previous || previous.status !== agent.status || (previous.stage ?? previous.summary) !== stage || previous.generation !== agent.generation;
    if (previous && previous.status === agent.status && (previous.stage ?? previous.summary) === stage
      && previous.updatedAt === agent.updatedAt && previous.generation === agent.generation && previous.usage === agent.usage) continue;
    const list = entry.marks.get(agent.agentId) ?? [];
    if (!transition && now - list[list.length - 1]!.at < 1000) continue;
    entry.last.set(agent.agentId, agent);
    list.push({ at: now, status: agent.status, snapshot: agent, transition, ...(stage === undefined ? {} : { stage }) });
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
    // Trim periodic usage first, keeping lifecycle/stage events and each agent's latest.
    const all = [...entry.marks.entries()].flatMap(([id, list]) => list.slice(0, -1).map(mark => ({ id, mark })));
    all.sort((a, b) => Number(a.mark.transition) - Number(b.mark.transition) || a.mark.at - b.mark.at);
    for (const { id, mark } of all.slice(0, entry.total - TOTAL)) {
      const list = entry.marks.get(id)!;
      list.splice(list.indexOf(mark), 1);
      entry.total -= 1;
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

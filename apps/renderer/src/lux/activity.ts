/**
 * What the window's light should say about the agents in it.
 *
 * Every composer that shows state light reports its own state here; the
 * ambient field reads the strongest one (waiting > running > idle). Kept out
 * of React state and off <html> on purpose: it changes when a turn starts or
 * ends, and the only element that restyles is the ambient field itself.
 */

export type LuxActivity = "idle" | "running" | "waiting";

const RANK: Readonly<Record<LuxActivity, number>> = { idle: 0, running: 1, waiting: 2 };

const sources = new Map<symbol, LuxActivity>();
const listeners = new Set<() => void>();
let current: LuxActivity = "idle";

function recompute(): void {
  let next: LuxActivity = "idle";
  for (const state of sources.values()) if (RANK[state] > RANK[next]) next = state;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

export function reportLuxActivity(source: symbol, state: LuxActivity): void {
  if (state === "idle") sources.delete(source);
  else sources.set(source, state);
  recompute();
}

export function clearLuxActivity(source: symbol): void {
  sources.delete(source);
  recompute();
}

export function getLuxActivity(): LuxActivity {
  return current;
}

export function subscribeLuxActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

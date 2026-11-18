import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import type { DeckAgent, DeckTone } from "./deckModel";
import { buildDeck, deckTone, toneSettled } from "./deckModel";
import type { SwarmMark, SwarmMemory } from "./swarmRecorder";

export type LaneMark = { readonly at: number; readonly text: string };
export type Lane = {
  readonly row: DeckAgent;
  readonly start: number;
  /** Undefined while the agent still works: the bar runs to "now". */
  readonly end?: number;
  readonly marks: readonly LaneMark[];
  readonly transitions: readonly SwarmMark[];
};

/** Preview only: the demo story's stage changes, in place of what the recorder saw. */
export function buildLanes(rows: readonly DeckAgent[], memory: SwarmMemory, now: number, demoMarks?: (id: string) => readonly LaneMark[] | undefined): Lane[] {
  return rows.map(row => {
    const transitions = memory.marks.get(row.id) ?? [];
    const start = row.startedAt ?? memory.firstSeen.get(row.id) ?? Math.min(row.updatedAt, now);
    let marks: LaneMark[] = [];
    const scripted = demoMarks?.(row.id);
    if (scripted) marks = scripted.filter(mark => mark.at >= start);
    else {
      let previous: string | undefined;
      for (const mark of transitions) {
        if (mark.stage !== undefined && mark.stage !== previous && mark.at >= start) marks.push({ at: mark.at, text: mark.stage });
        previous = mark.stage;
      }
    }
    const end = toneSettled(row.tone) ? Math.max(start, Math.min(row.updatedAt, now)) : undefined;
    return { row, start, ...(end === undefined ? {} : { end }), marks, transitions };
  });
}

export function laneRange(lanes: readonly Lane[], now: number): { start: number; end: number } {
  let start = now, end = now;
  for (const lane of lanes) {
    start = Math.min(start, lane.start);
    end = Math.max(end, lane.end ?? now);
  }
  // Always show a little history, so one fresh agent is not a full-width bar.
  return { start: Math.min(start, end - 60_000), end };
}

/** What a lane showed at instant `at`: absent before it started, its recorded or final tone after. */
export function laneToneAt(lane: Lane, at: number): DeckTone | undefined {
  if (at < lane.start) return undefined;
  if (lane.end !== undefined && at >= lane.end) return lane.row.tone;
  // Inside the bar the agent was working, unless a recorded change says it rested then.
  let status: SwarmMark["status"] | undefined;
  for (const mark of lane.transitions) { if (mark.at <= at) status = mark.status; else break; }
  const recorded = status === undefined ? undefined : deckTone(status);
  if (recorded !== undefined) return recorded;
  return lane.row.tone === "waiting" && at >= lane.row.updatedAt ? "waiting" : "running";
}

export function stageAt(lane: Lane, at: number): string | undefined {
  let text: string | undefined;
  for (const mark of lane.marks) { if (mark.at <= at) text = mark.text; else break; }
  return text;
}

/** Every replay surface shares these members and snapshots; unobserved usage stays unknown. */
export function replayLanes(lanes: readonly Lane[], at: number, zh: boolean): Lane[] {
  const snapshots: StudioAgentSnapshot[] = [];
  const tones = new Map<string, DeckTone>();
  for (const lane of lanes) {
    const tone = laneToneAt(lane, at);
    if (tone === undefined) continue;
    tones.set(lane.row.id, tone);
    let snapshot: StudioAgentSnapshot | undefined;
    for (const mark of lane.transitions) {
      if (mark.at > at) break;
      snapshot = mark.snapshot;
    }
    if (snapshot) snapshots.push(snapshot);
    else {
      // The identity and assignment are known, but the current progress and output weren't observed then.
      const { usage, completionPercent, taskSteps, stage, summary, outputPath, patchPath, branchName, ...identity } = lane.row.agent;
      const status = tone === "waiting" ? "running" : tone === "stopped" ? "aborted" : tone;
      const historicalStage = stageAt(lane, at);
      snapshots.push({ ...identity, status, updatedAt: new Date(at).toISOString(), unreadCount: 0,
        ...(historicalStage === undefined ? {} : { stage: historicalStage }) });
    }
  }
  const rows = new Map(buildDeck(snapshots, false, zh).map(row => {
    const tone = tones.get(row.id)!;
    return [row.id, tone === "waiting" ? { ...row, tone, group: "waiting" as const, statusText: zh ? "待处理" : "Waiting" } : row] as const;
  }));
  return lanes.flatMap(lane => {
    const row = rows.get(lane.row.id);
    if (!row) return [];
    const { end, ...rest } = lane;
    return [{ ...rest, row, ...(end !== undefined && end <= at ? { end } : {}),
      marks: lane.marks.filter(mark => mark.at <= at), transitions: lane.transitions.filter(mark => mark.at <= at) }];
  });
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400].map(seconds => seconds * 1000);

/** Tick instants at a "nice" step so labels sit about `spacing` pixels apart. */
export function timeTicks(start: number, end: number, width: number, spacing = 96): number[] {
  if (width <= 0 || end <= start) return [];
  const target = (end - start) * spacing / width;
  const step = STEPS.find(candidate => candidate >= target) ?? STEPS[STEPS.length - 1]!;
  const ticks: number[] = [];
  for (let at = Math.ceil(start / step) * step; at <= end; at += step) ticks.push(at);
  return ticks;
}

export function tickLabel(at: number, span: number): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0"), mm = String(date.getMinutes()).padStart(2, "0"), ss = String(date.getSeconds()).padStart(2, "0");
  return span < 10 * 60_000 ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

/** Running lanes per bucket across the range: the concurrency curve under the axis (single-pass two-pointer scan). */
export function concurrency(lanes: readonly Lane[], start: number, end: number, now: number, buckets: number): number[] {
  const count = Math.max(1, buckets);
  const out = new Array<number>(count).fill(0);
  const span = Math.max(1, end - start);
  const bucketTimes = new Array<number>(count);
  for (let index = 0; index < count; index += 1) {
    bucketTimes[index] = start + (index / count) * span;
  }
  for (const lane of lanes) {
    if (lane.row.main) continue;
    const transitions = lane.transitions;
    let tIdx = 0;
    const firstBucket = Math.max(0, Math.floor(((lane.start - start) / span) * count));
    for (let index = firstBucket; index < count; index += 1) {
      const at = bucketTimes[index]!;
      if (at > now) break;
      if (at < lane.start) continue;
      if (lane.end !== undefined && at >= lane.end) {
        if (lane.row.tone === "running" || lane.row.tone === "waiting") out[index]! += 1;
        else break;
        continue;
      }
      while (tIdx < transitions.length && transitions[tIdx]!.at <= at) tIdx += 1;
      const status = tIdx > 0 ? transitions[tIdx - 1]!.status : undefined;
      const recorded = status === undefined ? undefined : deckTone(status);
      const tone = recorded !== undefined
        ? recorded
        : (lane.row.tone === "waiting" && at >= lane.row.updatedAt ? "waiting" : "running");
      if (tone === "running" || tone === "waiting") out[index]! += 1;
    }
  }
  return out;
}

/** Instants worth stopping at when replaying "by event": starts, ends and stage changes. */
export function eventInstants(lanes: readonly Lane[]): number[] {
  const set = new Set<number>();
  for (const lane of lanes) {
    set.add(lane.start);
    if (lane.end !== undefined) set.add(lane.end);
    for (const mark of lane.marks) set.add(mark.at);
  }
  return [...set].sort((a, b) => a - b);
}

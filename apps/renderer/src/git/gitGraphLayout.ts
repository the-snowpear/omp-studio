/**
 * Swimlane layout and SVG path generation for the Git sidebar graph.
 *
 * Adapted from VS Code `scmHistory.ts` (`toISCMHistoryItemViewModelArray`,
 * `renderSCMHistoryItemGraph`, `addIncomingOutgoingChangesHistoryItems`).
 *
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import type { GitLogCommitRecord, GitLogListReadModel, GitLogRef } from "@omp-studio/client-contract";

export const SWIMLANE_HEIGHT = 22;
export const SWIMLANE_WIDTH = 11;
const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

export const INCOMING_HISTORY_ID = "scm-graph-incoming-changes";
export const OUTGOING_HISTORY_ID = "scm-graph-outgoing-changes";

export const GRAPH_COLORS = {
  local: "#3794ff",
  remote: "#b180d7",
  base: "#ea5c00",
  lanes: ["#ffb000", "#dc267f", "#994f00", "#40b0a6", "#b66dff"],
} as const;

export type GraphRowKind = "HEAD" | "node" | "incoming-changes" | "outgoing-changes";

export interface GraphSwimlane {
  readonly id: string;
  readonly color: string;
}

export interface GraphPath {
  readonly d: string;
  readonly color: string;
  readonly strokeWidth: number;
}

export interface GraphCircle {
  readonly index: number;
  readonly radius: number;
  readonly strokeWidth: number;
  readonly color: string;
  readonly fill?: string;
  readonly dashed?: boolean;
}

export interface GraphRow {
  readonly id: string;
  readonly kind: GraphRowKind;
  readonly subject: string;
  readonly commit?: GitLogCommitRecord;
  readonly refs: readonly GitLogRef[];
  readonly parentIds: readonly string[];
  readonly inputSwimlanes: readonly GraphSwimlane[];
  readonly outputSwimlanes: readonly GraphSwimlane[];
  readonly circleIndex: number;
  readonly circleColor: string;
  readonly isMerge: boolean;
}

export interface GraphRowRender {
  readonly width: number;
  readonly height: number;
  readonly paths: readonly GraphPath[];
  readonly circles: readonly GraphCircle[];
}

function rot(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function cloneLane(lane: GraphSwimlane): GraphSwimlane {
  return { id: lane.id, color: lane.color };
}

function findLastIndex(nodes: readonly GraphSwimlane[], id: string): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index]?.id === id) return index;
  }
  return -1;
}

function labelColor(commit: GitLogCommitRecord, colorMap: ReadonlyMap<string, string>): string | undefined {
  if (commit.oid === INCOMING_HISTORY_ID) return GRAPH_COLORS.remote;
  if (commit.oid === OUTGOING_HISTORY_ID) return GRAPH_COLORS.local;
  for (const ref of commit.refs) {
    const mapped = colorMap.get(ref.name);
    if (mapped !== undefined) return mapped;
  }
  return undefined;
}

function circleIndexOf(id: string, inputSwimlanes: readonly GraphSwimlane[]): number {
  const inputIndex = inputSwimlanes.findIndex((lane) => lane.id === id);
  return inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
}

function circleColorOf(circleIndex: number, inputSwimlanes: readonly GraphSwimlane[], outputSwimlanes: readonly GraphSwimlane[]): string {
  if (circleIndex < outputSwimlanes.length) return outputSwimlanes[circleIndex]!.color;
  if (circleIndex < inputSwimlanes.length) return inputSwimlanes[circleIndex]!.color;
  return GRAPH_COLORS.local;
}

function buildColorMap(model: GitLogListReadModel): Map<string, string> {
  const colorMap = new Map<string, string>();
  if (model.upstream) colorMap.set(model.upstream, GRAPH_COLORS.remote);
  for (const commit of model.commits) {
    for (const ref of commit.refs) {
      if (ref.kind === "head" || (ref.kind === "local" && ref.current)) colorMap.set(ref.name, GRAPH_COLORS.local);
      else if (ref.kind === "remote" && !colorMap.has(ref.name)) colorMap.set(ref.name, GRAPH_COLORS.remote);
    }
  }
  return colorMap;
}

function toRow(options: {
  readonly id: string;
  readonly kind: GraphRowKind;
  readonly subject: string;
  readonly commit?: GitLogCommitRecord;
  readonly refs: readonly GitLogRef[];
  readonly parentIds: readonly string[];
  readonly inputSwimlanes: readonly GraphSwimlane[];
  readonly outputSwimlanes: readonly GraphSwimlane[];
}): GraphRow {
  const circleIndex = circleIndexOf(options.id, options.inputSwimlanes);
  return {
    ...options,
    circleIndex,
    circleColor: circleColorOf(circleIndex, options.inputSwimlanes, options.outputSwimlanes),
    isMerge: options.parentIds.length > 1,
  };
}

function insertIncomingOutgoing(rows: GraphRow[], model: GitLogListReadModel): GraphRow[] {
  const next = [...rows];
  const headOid = model.headOid;
  const mergeBase = model.mergeBaseOid;
  const upstream = model.upstream;
  if (headOid && mergeBase && headOid !== mergeBase && model.ahead > 0) {
    const headIndex = next.findIndex((row) => row.kind === "HEAD" && row.id === headOid);
    if (headIndex !== -1) {
      const head = next[headIndex]!;
      const inputSwimlanes = head.inputSwimlanes.map(cloneLane);
      const outputSwimlanes = [...inputSwimlanes, { id: headOid, color: GRAPH_COLORS.local }];
      next.splice(headIndex, 0, toRow({
        id: OUTGOING_HISTORY_ID,
        kind: "outgoing-changes",
        subject: "传出的更改",
        refs: [],
        parentIds: [headOid],
        inputSwimlanes,
        outputSwimlanes,
      }));
    }
  }
  if (upstream && mergeBase && model.behind > 0) {
    const beforeIndex = (() => {
      for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index]?.outputSwimlanes.some((lane) => lane.id === mergeBase)) return index;
      }
      return -1;
    })();
    const afterIndex = next.findIndex((row) => row.id === mergeBase);
    if (beforeIndex !== -1 && afterIndex !== -1) {
      const incomingMerged = next[beforeIndex]!.parentIds.length === 2 && next[beforeIndex]!.parentIds.includes(mergeBase);
      if (!incomingMerged) {
        const before = next[beforeIndex]!;
        const rewritten = toRow({
          id: before.id,
          kind: before.kind,
          subject: before.subject,
          ...(before.commit === undefined ? {} : { commit: before.commit }),
          refs: before.refs,
          parentIds: before.parentIds,
          inputSwimlanes: before.inputSwimlanes.map((lane) => (
            lane.id === mergeBase && lane.color === GRAPH_COLORS.remote ? { id: INCOMING_HISTORY_ID, color: lane.color } : lane
          )),
          outputSwimlanes: before.outputSwimlanes.map((lane) => (
            lane.id === mergeBase && lane.color === GRAPH_COLORS.remote ? { id: INCOMING_HISTORY_ID, color: lane.color } : lane
          )),
        });
        next[beforeIndex] = rewritten;
        const after = next[afterIndex]!;
        next.splice(afterIndex, 0, toRow({
          id: INCOMING_HISTORY_ID,
          kind: "incoming-changes",
          subject: "传入的更改",
          refs: [],
          parentIds: [mergeBase],
          inputSwimlanes: rewritten.outputSwimlanes.map(cloneLane),
          outputSwimlanes: after.inputSwimlanes.map(cloneLane),
        }));
      }
    }
  }
  return next;
}

export function buildGitGraphRows(model: GitLogListReadModel): GraphRow[] {
  const colorMap = buildColorMap(model);
  const rows: GraphRow[] = [];
  let colorIndex = -1;
  for (const commit of model.commits) {
    const kind: GraphRowKind = model.headOid !== undefined && commit.oid === model.headOid ? "HEAD" : "node";
    const inputSwimlanes = (rows.at(-1)?.outputSwimlanes ?? []).map(cloneLane);
    const outputSwimlanes: GraphSwimlane[] = [];
    let firstParentAdded = false;
    if (commit.parents.length > 0) {
      for (const lane of inputSwimlanes) {
        if (lane.id === commit.oid) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: commit.parents[0]!,
              color: labelColor(commit, colorMap) ?? lane.color,
            });
            firstParentAdded = true;
          }
          continue;
        }
        outputSwimlanes.push(cloneLane(lane));
      }
    }
    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index += 1) {
      let color = index === 0 ? labelColor(commit, colorMap) : undefined;
      if (color === undefined && index > 0) {
        const parent = model.commits.find((item) => item.oid === commit.parents[index]);
        color = parent ? labelColor(parent, colorMap) : undefined;
      }
      if (color === undefined) {
        colorIndex = rot(colorIndex + 1, GRAPH_COLORS.lanes.length);
        color = GRAPH_COLORS.lanes[colorIndex]!;
      }
      outputSwimlanes.push({ id: commit.parents[index]!, color });
    }
    rows.push(toRow({
      id: commit.oid,
      kind,
      subject: commit.subject,
      commit,
      refs: commit.refs,
      parentIds: commit.parents,
      inputSwimlanes,
      outputSwimlanes,
    }));
  }
  return insertIncomingOutgoing(rows, model);
}

export function renderGraphRow(row: GraphRow): GraphRowRender {
  const inputSwimlanes = row.inputSwimlanes;
  const outputSwimlanes = row.outputSwimlanes;
  const circleIndex = row.circleIndex;
  const paths: GraphPath[] = [];
  const circles: GraphCircle[] = [];
  let outputSwimlaneIndex = 0;

  for (let index = 0; index < inputSwimlanes.length; index += 1) {
    const color = inputSwimlanes[index]!.color;
    if (inputSwimlanes[index]!.id === row.id) {
      if (index !== circleIndex) {
        paths.push({
          color,
          strokeWidth: 1,
          d: `M ${SWIMLANE_WIDTH * (index + 1)} 0 A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH} H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
        });
      } else {
        outputSwimlaneIndex += 1;
      }
      continue;
    }
    if (outputSwimlaneIndex < outputSwimlanes.length && inputSwimlanes[index]!.id === outputSwimlanes[outputSwimlaneIndex]!.id) {
      if (index === outputSwimlaneIndex) {
        paths.push({ color, strokeWidth: 1, d: `M ${SWIMLANE_WIDTH * (index + 1)} 0 V ${SWIMLANE_HEIGHT}` });
      } else {
        paths.push({
          color,
          strokeWidth: 1,
          d: [
            `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
            "V 6",
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${SWIMLANE_WIDTH * (index + 1) - SWIMLANE_CURVE_RADIUS} ${SWIMLANE_HEIGHT / 2}`,
            `H ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1) + SWIMLANE_CURVE_RADIUS}`,
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${SWIMLANE_HEIGHT / 2 + SWIMLANE_CURVE_RADIUS}`,
            `V ${SWIMLANE_HEIGHT}`,
          ].join(" "),
        });
      }
      outputSwimlaneIndex += 1;
    }
  }

  for (let index = 1; index < row.parentIds.length; index += 1) {
    const parentOutputIndex = findLastIndex(outputSwimlanes, row.parentIds[index]!);
    if (parentOutputIndex === -1) continue;
    paths.push({
      color: outputSwimlanes[parentOutputIndex]!.color,
      strokeWidth: 1,
      d: [
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
        `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`,
        `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
        `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
      ].join(" "),
    });
  }

  const inputIndex = inputSwimlanes.findIndex((lane) => lane.id === row.id);
  if (inputIndex !== -1) {
    paths.push({ color: inputSwimlanes[inputIndex]!.color, strokeWidth: 1, d: `M ${SWIMLANE_WIDTH * (circleIndex + 1)} 0 V ${SWIMLANE_HEIGHT / 2}` });
  }
  if (row.parentIds.length > 0) {
    paths.push({ color: row.circleColor, strokeWidth: 1, d: `M ${SWIMLANE_WIDTH * (circleIndex + 1)} ${SWIMLANE_HEIGHT / 2} V ${SWIMLANE_HEIGHT}` });
  }

  if (row.kind === "HEAD") {
    circles.push({ index: circleIndex, radius: CIRCLE_RADIUS + 3, strokeWidth: CIRCLE_STROKE_WIDTH, color: row.circleColor, fill: "transparent" });
    circles.push({ index: circleIndex, radius: CIRCLE_STROKE_WIDTH, strokeWidth: 0, color: row.circleColor, fill: row.circleColor });
  } else if (row.kind === "incoming-changes" || row.kind === "outgoing-changes") {
    circles.push({ index: circleIndex, radius: CIRCLE_RADIUS + 3, strokeWidth: CIRCLE_STROKE_WIDTH, color: row.circleColor, fill: "transparent" });
    circles.push({ index: circleIndex, radius: CIRCLE_RADIUS + 1, strokeWidth: CIRCLE_STROKE_WIDTH + 1, color: row.circleColor, fill: "transparent" });
    circles.push({ index: circleIndex, radius: CIRCLE_RADIUS + 1, strokeWidth: CIRCLE_STROKE_WIDTH - 1, color: row.circleColor, fill: "transparent", dashed: true });
  } else if (row.isMerge) {
    circles.push({ index: circleIndex, radius: CIRCLE_RADIUS + 2, strokeWidth: CIRCLE_STROKE_WIDTH, color: row.circleColor, fill: "transparent" });
    circles.push({ index: circleIndex, radius: CIRCLE_RADIUS - 1, strokeWidth: CIRCLE_STROKE_WIDTH, color: row.circleColor, fill: row.circleColor });
  } else {
    circles.push({ index: circleIndex, radius: CIRCLE_RADIUS + 1, strokeWidth: CIRCLE_STROKE_WIDTH, color: row.circleColor, fill: row.circleColor });
  }

  return {
    width: SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1),
    height: SWIMLANE_HEIGHT,
    paths,
    circles,
  };
}

/** Vertical continuations of output swimlanes, stretched below the node row when a commit is expanded. */
export function renderGraphThroughLanes(row: GraphRow): GraphRowRender {
  const width = SWIMLANE_WIDTH * (Math.max(row.inputSwimlanes.length, row.outputSwimlanes.length, 1) + 1);
  return {
    width,
    height: 1,
    paths: row.outputSwimlanes.map((lane, index) => ({
      color: lane.color,
      strokeWidth: 1,
      d: `M ${SWIMLANE_WIDTH * (index + 1)} 0 V 1`,
    })),
    circles: [],
  };
}

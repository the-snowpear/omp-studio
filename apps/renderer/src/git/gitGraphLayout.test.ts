import { describe, expect, it } from "vitest";

import type { GitLogCommitRecord, GitLogListReadModel } from "@omp-studio/client-contract";

import { buildGitGraphRows, INCOMING_HISTORY_ID, OUTGOING_HISTORY_ID, renderGraphRow, renderGraphThroughLanes } from "./gitGraphLayout";

const WORKSPACE = "ws-1" as GitLogListReadModel["workspaceId"];

function commit(partial: Partial<GitLogCommitRecord> & Pick<GitLogCommitRecord, "oid" | "parents" | "subject">): GitLogCommitRecord {
  return {
    authorName: "Ada",
    authorDate: "2026-08-17T00:00:00Z",
    refs: [],
    relation: "common",
    ...partial,
  };
}

describe("buildGitGraphRows", () => {
  it("assigns a side lane for a merge parent and marks HEAD", () => {
    const head = "a".repeat(40);
    const feature = "b".repeat(40);
    const base = "c".repeat(40);
    const model: GitLogListReadModel = {
      workspaceId: WORKSPACE,
      truncated: false,
      headOid: head,
      upstream: "origin/main",
      mergeBaseOid: base,
      ahead: 2,
      behind: 0,
      commits: [
        commit({
          oid: head,
          parents: [base, feature],
          subject: "merge: integrate feature",
          relation: "head",
          refs: [
            { name: "HEAD", kind: "head", current: true },
            { name: "main", kind: "local", current: true },
          ],
        }),
        commit({ oid: feature, parents: [base], subject: "feat: side work", relation: "outgoing" }),
        commit({
          oid: base,
          parents: [],
          subject: "initial",
          refs: [{ name: "origin/main", kind: "remote", current: false }],
        }),
      ],
    };
    const rows = buildGitGraphRows(model);
    expect(rows[0]?.kind).toBe("outgoing-changes");
    expect(rows[0]?.id).toBe(OUTGOING_HISTORY_ID);
    const headRow = rows.find((row) => row.kind === "HEAD");
    expect(headRow?.isMerge).toBe(true);
    expect(headRow?.outputSwimlanes.length).toBeGreaterThan(1);
    const featureRow = rows.find((row) => row.id === feature);
    expect(featureRow?.circleIndex).toBeGreaterThanOrEqual(0);
    expect(rows.some((row) => row.id === INCOMING_HISTORY_ID)).toBe(false);
  });

  it("inserts an incoming node when the branch is behind", () => {
    const head = "d".repeat(40);
    const incoming = "e".repeat(40);
    const base = "f".repeat(40);
    const model: GitLogListReadModel = {
      workspaceId: WORKSPACE,
      truncated: false,
      headOid: head,
      upstream: "origin/main",
      mergeBaseOid: base,
      ahead: 0,
      behind: 1,
      commits: [
        commit({
          oid: incoming,
          parents: [base],
          subject: "incoming",
          relation: "incoming",
          refs: [{ name: "origin/main", kind: "remote", current: false }],
        }),
        commit({
          oid: head,
          parents: [base],
          subject: "local",
          relation: "head",
          refs: [{ name: "main", kind: "local", current: true }],
        }),
        commit({ oid: base, parents: [], subject: "base" }),
      ],
    };
    const rows = buildGitGraphRows(model);
    expect(rows.some((row) => row.kind === "incoming-changes")).toBe(true);
  });
});

describe("renderGraphRow", () => {
  it("draws a merge node with more than one circle", () => {
    const rendered = renderGraphRow({
      id: "a".repeat(40),
      kind: "HEAD",
      subject: "merge",
      refs: [],
      parentIds: ["b".repeat(40), "c".repeat(40)],
      inputSwimlanes: [],
      outputSwimlanes: [
        { id: "b".repeat(40), color: "#3794ff" },
        { id: "c".repeat(40), color: "#ffb000" },
      ],
      circleIndex: 0,
      circleColor: "#3794ff",
      isMerge: true,
    });
    expect(rendered.circles.length).toBeGreaterThan(1);
    expect(rendered.paths.length).toBeGreaterThan(0);
    expect(rendered.width).toBeGreaterThan(11);
  });

  it("continues every output swimlane as a vertical through-line", () => {
    const rendered = renderGraphThroughLanes({
      id: "a".repeat(40),
      kind: "node",
      subject: "work",
      refs: [],
      parentIds: ["b".repeat(40)],
      inputSwimlanes: [{ id: "a".repeat(40), color: "#3794ff" }, { id: "side", color: "#ffb000" }],
      outputSwimlanes: [{ id: "b".repeat(40), color: "#3794ff" }, { id: "side", color: "#ffb000" }],
      circleIndex: 0,
      circleColor: "#3794ff",
      isMerge: false,
    });
    expect(rendered.paths).toHaveLength(2);
    expect(rendered.paths[0]?.d).toContain("V 1");
    expect(rendered.paths[1]?.color).toBe("#ffb000");
    expect(rendered.circles).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { emptySnapshot } from "../composer/types";
import { emptyConversationState } from "./conversationViewModel";
import {
  findSubagentComposerAgent,
  subagentComposerText,
  subagentComposerVisible,
  subagentTurnRunning,
  type SubagentComposerAgent,
} from "./subagentComposerGate";

const LIVE: SubagentComposerAgent = {
  agentId: "agent-019fcb01",
  kind: "task",
  status: "idle",
};

const OPEN = {
  preview: false,
  runtimeConnected: true,
  hasClient: true,
  canSend: true,
  agent: LIVE,
} as const;

describe("subagentComposerVisible", () => {
  it("shows for a live connected agent with agent.send", () => {
    expect(subagentComposerVisible(OPEN)).toBe(true);
    expect(subagentComposerVisible({ ...OPEN, agent: { ...LIVE, status: "running" } })).toBe(true);
    expect(subagentComposerVisible({ ...OPEN, agent: { ...LIVE, status: "parked" } })).toBe(true);
  });

  it("hides in preview unless previewComposer is on, and when the send channel is not ready", () => {
    expect(subagentComposerVisible({ ...OPEN, preview: true })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, preview: true, previewComposer: true })).toBe(true);
    expect(subagentComposerVisible({ ...OPEN, preview: true, previewComposer: true, agent: { ...LIVE, kind: "advisor" } })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, runtimeConnected: false })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, hasClient: false })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, canSend: false })).toBe(false);
  });

  it("hides when the agent is missing, read-only, or terminal", () => {
    expect(subagentComposerVisible({ ...OPEN, agent: undefined })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, agent: { ...LIVE, kind: "advisor" } })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, agent: { ...LIVE, readOnly: true } })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, agent: { ...LIVE, status: "aborted" } })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, agent: { ...LIVE, status: "failed" } })).toBe(false);
    expect(subagentComposerVisible({ ...OPEN, agent: { ...LIVE, status: "released" } })).toBe(false);
  });

  it("looks up the roster by agent id", () => {
    expect(findSubagentComposerAgent([LIVE], "agent-019fcb01")).toEqual(LIVE);
    expect(findSubagentComposerAgent([LIVE], "missing")).toBeUndefined();
  });
});

describe("subagentTurnRunning", () => {
  it("is idle on an empty conversation and live when a turn is open", () => {
    expect(subagentTurnRunning(emptyConversationState())).toBe(false);
    expect(subagentTurnRunning({
      ...emptyConversationState(),
      openTurnItems: { "item-1": "turn-1" },
    })).toBe(true);
  });
});

describe("subagentComposerText", () => {
  it("requires non-empty serialized text and forwards clipboard images", () => {
    expect(subagentComposerText(emptySnapshot())).toEqual({ kind: "empty" });
    expect(subagentComposerText({
      ...emptySnapshot(),
      text: "  continue  ",
    })).toEqual({ kind: "ready", text: "continue" });
    expect(subagentComposerText({
      ...emptySnapshot(),
      text: "[图1]",
      images: [{ type: "image", mimeType: "image/png", data: "abc" }],
    })).toEqual({
      kind: "ready",
      text: "[图1]",
      images: [{ type: "image", mimeType: "image/png", data: "abc" }],
    });
    expect(subagentComposerText({
      ...emptySnapshot(),
      text: "@assets/logo.png",
    })).toEqual({ kind: "ready", text: "@assets/logo.png" });
  });
});

import { describe, expect, it } from "vitest";

import {
  canFlushQueuedMessage,
  composerFollowUpEnabled,
  composerPromptEnabled,
  composerQueueEnabled,
  visibleQueuedMessages,
} from "./dispatch";

/**
 * Simulated composer → Runtime command choice. These are the contracts the
 * App.tsx send/queue/flush path must keep vs OMP TUI.
 */
describe("composer send path (simulated vs OMP)", () => {
  it("idle Enter with no ask/approval card enables a fresh core.prompt", () => {
    expect(
      composerPromptEnabled({
        textReady: true,
        running: false,
        pendingInteraction: false,
        promptChannelReady: true,
      }),
    ).toBe(true);
    expect(
      composerQueueEnabled({
        textReady: true,
        running: false,
        promptChannelReady: true,
      }),
    ).toBe(false);
  });

  it("streaming Enter does not prompt; it enables the local follow-up bar instead of OMP steer", () => {
    expect(
      composerPromptEnabled({
        textReady: true,
        running: true,
        pendingInteraction: false,
        promptChannelReady: true,
      }),
    ).toBe(false);
    expect(
      composerQueueEnabled({
        textReady: true,
        running: true,
        promptChannelReady: true,
      }),
    ).toBe(true);
  });

  it("allows send on a new-conversation welcome page even when the prompt channel is down", () => {
    expect(
      composerPromptEnabled({
        textReady: true,
        running: false,
        pendingInteraction: false,
        promptChannelReady: false,
        newConversation: true,
      }),
    ).toBe(true);
    expect(
      composerPromptEnabled({
        textReady: true,
        running: false,
        pendingInteraction: false,
        promptChannelReady: false,
      }),
    ).toBe(false);
  });

  it("blocks a new prompt while an ask/approval card owns the interaction surface", () => {
    expect(
      composerPromptEnabled({
        textReady: true,
        running: false,
        pendingInteraction: true,
        promptChannelReady: true,
      }),
    ).toBe(false);
  });

  it("refuses to flush session A's queued draft into idle session B", () => {
    expect(
      canFlushQueuedMessage({
        running: false,
        pendingInteraction: false,
        promptChannelReady: true,
        selectedSessionId: "sess-b",
        liveSessionId: "sess-b",
        entrySessionId: "sess-a",
      }),
    ).toBe(false);
    expect(
      canFlushQueuedMessage({
        running: false,
        pendingInteraction: false,
        promptChannelReady: true,
        selectedSessionId: "sess-a",
        liveSessionId: "sess-a",
        entrySessionId: "sess-a",
      }),
    ).toBe(true);
  });

  it("holds the flush while the queue head is being edited in Composer", () => {
    expect(
      canFlushQueuedMessage({
        running: false,
        pendingInteraction: false,
        promptChannelReady: true,
        selectedSessionId: "sess-a",
        liveSessionId: "sess-a",
        entrySessionId: "sess-a",
        entryId: 1,
        pausedEntryId: 1,
      }),
    ).toBe(false);
    expect(
      canFlushQueuedMessage({
        running: false,
        pendingInteraction: false,
        promptChannelReady: true,
        selectedSessionId: "sess-a",
        liveSessionId: "sess-a",
        entrySessionId: "sess-a",
        entryId: 1,
        pausedEntryId: 2,
      }),
    ).toBe(true);
  });

  it("holds the flush while the live session is still streaming or waiting on interaction", () => {
    expect(
      canFlushQueuedMessage({
        running: true,
        pendingInteraction: false,
        promptChannelReady: true,
        selectedSessionId: "sess-a",
        liveSessionId: "sess-a",
        entrySessionId: "sess-a",
      }),
    ).toBe(false);
    expect(
      canFlushQueuedMessage({
        running: false,
        pendingInteraction: true,
        promptChannelReady: true,
        selectedSessionId: "sess-a",
        liveSessionId: "sess-a",
        entrySessionId: "sess-a",
      }),
    ).toBe(false);
  });

  it("Ctrl+Enter follow-up is allowed while streaming and blocked only when idle with an ask card", () => {
    expect(
      composerFollowUpEnabled({
        textReady: true,
        running: true,
        pendingInteraction: true,
        followUpChannelReady: true,
      }),
    ).toBe(true);
    expect(
      composerFollowUpEnabled({
        textReady: true,
        running: false,
        pendingInteraction: true,
        followUpChannelReady: true,
      }),
    ).toBe(false);
    expect(
      composerFollowUpEnabled({
        textReady: true,
        running: false,
        pendingInteraction: false,
        followUpChannelReady: true,
      }),
    ).toBe(true);
  });

  it("shows only the viewed session's queue so a switch cannot leak another thread's drafts", () => {
    const queue = [
      { id: 1, text: "for A", sessionId: "sess-a" },
      { id: 2, text: "for B", sessionId: "sess-b" },
    ];
    expect(visibleQueuedMessages(queue, "sess-b").map((entry) => entry.text)).toEqual(["for B"]);
    expect(visibleQueuedMessages(queue, undefined)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import {
  canFlushQueuedMessage,
  composerFollowUpEnabled,
  composerOwnerSessionId,
  composerOwnsLiveSnapshot,
  composerPromptEnabled,
  composerQueueEnabled,
  composerRunningForTarget,
  createComposerDispatchGate,
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
      { id: 3, text: "unstamped" },
    ];
    expect(visibleQueuedMessages(queue, "sess-b").map((entry) => entry.text)).toEqual(["for B", "unstamped"]);
    expect(visibleQueuedMessages(queue, undefined)).toEqual([]);
  });

  it("enables local queueing while running even if promptChannel is in transit (sending/busy)", () => {
    expect(
      composerQueueEnabled({
        textReady: true,
        running: true,
        promptChannelReady: false,
      }),
    ).toBe(true);
  });

  it("canFlushQueuedMessage falls back to selectedSessionId if entrySessionId is undefined", () => {
    expect(
      canFlushQueuedMessage({
        running: false,
        pendingInteraction: false,
        promptChannelReady: true,
        selectedSessionId: "sess-a",
        liveSessionId: "sess-a",
      }),
    ).toBe(true);
  });
});

/**
 * Regression: session A streaming, the operator clicks "new conversation" in
 * the same project and sends while `session.create` is still in flight. The
 * Runtime snapshot still names A, so the composer must not adopt A's session,
 * its streaming verdict, or its local queue for the new conversation's prompt.
 */
describe("composer ownership across a pending session.create", () => {
  const pendingDraft = { sessionCreating: true, liveSessionId: "sess-a" } as const;
  const ownedLive = { selectedSessionId: "sess-a", liveSessionId: "sess-a" } as const;

  it("gives a fresh-draft surface no owner while its session is being created", () => {
    expect(composerOwnerSessionId(pendingDraft)).toBeUndefined();
    expect(composerOwnerSessionId({ liveSessionId: "sess-b" })).toBe("sess-b");
    expect(composerOwnerSessionId(ownedLive)).toBe("sess-a");
    expect(composerOwnerSessionId({})).toBeUndefined();
  });

  it("does not let a pending draft own the previous session's live snapshot", () => {
    expect(composerOwnsLiveSnapshot(pendingDraft)).toBe(false);
    expect(composerOwnsLiveSnapshot(ownedLive)).toBe(true);
    expect(composerOwnsLiveSnapshot({ selectedSessionId: "sess-a", liveSessionId: "sess-b" })).toBe(false);
    expect(composerOwnsLiveSnapshot({})).toBe(false);
  });

  it("routes Enter to the new conversation instead of queueing it onto the streaming session", () => {
    // The bug: `running` came from A's snapshot and the entry was stamped sess-a.
    const composerRunning = composerRunningForTarget({ ...pendingDraft, running: true });
    expect(composerRunning).toBe(false);
    expect(composerQueueEnabled({ textReady: true, running: composerRunning, promptChannelReady: false })).toBe(false);
    // The new conversation may still send: it waits for its own session.
    expect(
      composerPromptEnabled({
        textReady: true,
        running: composerRunning,
        pendingInteraction: false,
        promptChannelReady: false,
        sessionCreating: true,
        newConversation: true,
      }),
    ).toBe(true);
  });

  it("keeps queueing for the conversation that is actually streaming", () => {
    expect(composerRunningForTarget({ ...ownedLive, running: true })).toBe(true);
    // Draft surface whose own `session.create` has landed: the live session IS it.
    expect(composerRunningForTarget({ running: true, liveSessionId: "sess-b" })).toBe(true);
    // Viewing a history thread while another session streams: no local queue.
    expect(
      composerRunningForTarget({ running: true, selectedSessionId: "sess-a", liveSessionId: "sess-b" }),
    ).toBe(false);
  });

  it("leaves a pending-draft queue invisible and never flushed into the left session", () => {
    const queue = [{ id: 1, text: "for the new chat", sessionId: "sess-a" }];
    const owner = composerOwnerSessionId(pendingDraft);
    // The draft surface owns no session, so sess-a's rows must not show there.
    expect(owner).toBeUndefined();
    expect(visibleQueuedMessages(queue, owner)).toEqual([]);
    // And a row stamped with the left session can only ever flush back into it,
    // which the draft surface (no selected session) refuses.
    expect(
      canFlushQueuedMessage({
        running: false,
        pendingInteraction: false,
        promptChannelReady: true,
        ...(owner === undefined ? {} : { selectedSessionId: owner }),
        liveSessionId: "sess-a",
        entrySessionId: "sess-a",
      }),
    ).toBe(false);
  });
});

it("keeps the second draft unsent while the first prompt waits for session creation", async () => {
  const gate = createComposerDispatchGate();
  let completeCreate!: () => void;
  const creation = new Promise<void>(resolve => { completeCreate = resolve; });
  const sent: string[] = [];
  const send = async (message: string) => {
    if (!gate.tryEnter()) return false;
    try { await creation; sent.push(message); return true; }
    finally { gate.leave(); }
  };
  const first = send("first");
  // Same-frame submission is blocked before React can publish sending=true.
  expect(await send("second")).toBe(false);
  expect(composerPromptEnabled({ textReady: true, running: false, sending: true, pendingInteraction: false, promptChannelReady: false, sessionCreating: true, newConversation: true })).toBe(false);
  expect(sent).toEqual([]);
  completeCreate();
  expect(await first).toBe(true);
  expect(await send("second")).toBe(true);
  expect(sent).toEqual(["first", "second"]);
});

it("releases dispatch ownership after a failed creation so the draft can be retried", async () => {
  const gate = createComposerDispatchGate();
  expect(gate.tryEnter()).toBe(true);
  const failed = async () => {
    try { await Promise.reject(new Error("session.create failed")); }
    finally { gate.leave(); }
  };
  await expect(failed()).rejects.toThrow("session.create failed");
  expect(gate.tryEnter()).toBe(true);
  gate.leave();
});

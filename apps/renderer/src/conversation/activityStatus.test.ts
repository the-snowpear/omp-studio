import { describe, expect, it } from "vitest";
import {
  deriveActivityStatus,
  isAbortEligible,
  reduceAwaitingTurn,
  reduceRunStreaming,
  WORKING_LABEL,
  type RunTrust,
} from "./activityStatus";
import { emptyConversationState } from "./conversationViewModel";

const IDENTITY = "session-1";

type RunStep = { readonly runtimeStreaming: boolean; readonly conversationLive: boolean };

/** Threads the render-time reducer the way `useRunStreaming` does. */
function runStreaming(steps: readonly RunStep[]): { streaming: boolean; settled: boolean }[] {
  let hold: { identityKey: string; trust: RunTrust; conversationLive: boolean } = {
    identityKey: IDENTITY,
    trust: "early",
    conversationLive: false,
  };
  return steps.map((step) => {
    const next = reduceRunStreaming(hold, { identityKey: IDENTITY, ...step });
    hold = { identityKey: next.identityKey, trust: next.trust, conversationLive: next.conversationLive };
    return { streaming: next.streaming, settled: next.settled };
  });
}

describe("reduceRunStreaming", () => {
  it("trusts conversation events that lead the isStreaming snapshot", () => {
    expect(runStreaming([{ runtimeStreaming: false, conversationLive: true }])).toEqual([
      { streaming: true, settled: false },
    ]);
  });

  it("drops residual live state once the Runtime reports idle, and keeps it dropped", () => {
    // A retryable provider error parks the logical turn on `agent_end{isTerminal:
    // false}`; a user abort supersedes the continuation that would have closed it,
    // so `openTurnItems` never clears. Trusting it here pinned `working` forever.
    const seen = runStreaming([
      { runtimeStreaming: false, conversationLive: true },
      { runtimeStreaming: true, conversationLive: true },
      { runtimeStreaming: false, conversationLive: true },
      { runtimeStreaming: false, conversationLive: true },
    ]);
    expect(seen.map((step) => step.streaming)).toEqual([true, true, false, false]);
    expect(seen.map((step) => step.settled)).toEqual([false, false, true, true]);
  });

  it("re-arms on a rising conversation edge: that is a new run, not residue", () => {
    const seen = runStreaming([
      { runtimeStreaming: true, conversationLive: true },
      { runtimeStreaming: false, conversationLive: false },
      { runtimeStreaming: false, conversationLive: true },
    ]);
    expect(seen.map((step) => step.streaming)).toEqual([true, false, true]);
    expect(seen.at(-1)).toEqual({ streaming: true, settled: false });
  });

  it("resets on an identity change so a settled verdict never crosses sessions", () => {
    const next = reduceRunStreaming(
      { identityKey: IDENTITY, trust: "runtime-settled", conversationLive: true },
      { identityKey: "session-2", runtimeStreaming: false, conversationLive: true },
    );
    expect(next).toMatchObject({ identityKey: "session-2", streaming: true, settled: false });
  });
});

describe("reduceAwaitingTurn", () => {
  const idle = { sending: false, pending: false, streaming: false, failed: false };

  it("clears an abort-cancelled latch that never saw streaming", () => {
    let state = reduceAwaitingTurn(
      { latched: false, wasStreaming: false, cancelGeneration: 0 },
      { ...idle, sending: true },
    );
    expect(state.latched).toBe(true);
    // No streaming rising edge ever happened, so the falling-edge escape can
    // never fire: without `cancelGeneration` this latch is permanent.
    state = reduceAwaitingTurn(state, { ...idle, cancelGeneration: 0 });
    expect(state.latched).toBe(true);
    state = reduceAwaitingTurn(state, { ...idle, cancelGeneration: 1 });
    expect(state.latched).toBe(false);
  });

  it("lets a mid-stream abort keep the line up until streaming actually falls", () => {
    let state = reduceAwaitingTurn(
      { latched: true, wasStreaming: true, cancelGeneration: 0 },
      { ...idle, streaming: true, cancelGeneration: 1 },
    );
    expect(state.latched).toBe(false);
    state = reduceAwaitingTurn(state, { ...idle, streaming: true, cancelGeneration: 1 });
    expect(state.latched).toBe(true);
    state = reduceAwaitingTurn(state, { ...idle, cancelGeneration: 1 });
    expect(state.latched).toBe(false);
  });

  it("still clears on a streaming falling edge and on a failed send", () => {
    const fell = reduceAwaitingTurn({ latched: true, wasStreaming: true }, idle);
    expect(fell).toMatchObject({ latched: false, wasStreaming: false });
    const failed = reduceAwaitingTurn({ latched: true, wasStreaming: false }, { ...idle, failed: true });
    expect(failed.latched).toBe(false);
    const pendingStillOut = reduceAwaitingTurn({ latched: true, wasStreaming: true }, { ...idle, pending: true });
    expect(pendingStillOut.latched).toBe(true);
  });
});

describe("deriveActivityStatus", () => {
  it("is a bare working line without live progress, and nothing at all once idle", () => {
    const state = emptyConversationState(1);
    expect(deriveActivityStatus({ state, streaming: true, pendingMessages: 0 })).toEqual({
      phase: "waiting",
      label: WORKING_LABEL,
    });
    expect(deriveActivityStatus({ state, streaming: false, pendingMessages: 0 })).toBeNull();
  });
});

describe("isAbortEligible", () => {
  it("arms on the send gap and never off-session", () => {
    expect(isAbortEligible({ executionMatches: true, streaming: false, pendingMessages: 0, awaiting: true })).toBe(true);
    expect(isAbortEligible({ executionMatches: true, streaming: false, pendingMessages: 0, awaiting: false })).toBe(false);
    expect(
      isAbortEligible({ executionMatches: false, streaming: true, pendingMessages: 3, awaiting: true, retrying: true }),
    ).toBe(false);
  });
});

export const CONVERSATION_COMMIT_INTERVAL_MS = 45;

export type ConversationCommitPriority = "normal" | "terminal";

export type ConversationCommitGate = {
  notify(priority?: ConversationCommitPriority): void;
  reset(): void;
};

type GateClock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
};

const defaultClock: GateClock = {
  now: () => (typeof performance === "object" ? performance.now() : Date.now()),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
};

/** Single trailing gate shared by main and subagent transcript hooks. */
export function createConversationCommitGate(
  flush: () => void,
  intervalMs = CONVERSATION_COMMIT_INTERVAL_MS,
  clock: GateClock = defaultClock,
): ConversationCommitGate {
  let lastFlush = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;

  const clearPendingTimer = () => {
    if (timer !== undefined) clock.clearTimer(timer);
    timer = undefined;
  };
  const flushPending = () => {
    clearPendingTimer();
    if (!pending) return;
    pending = false;
    lastFlush = clock.now();
    flush();
  };
  return {
    notify(priority = "normal") {
      const now = clock.now();
      if (priority === "terminal") {
        if (pending) flushPending();
        else if (now - lastFlush >= 1) {
          lastFlush = now;
          flush();
        }
        return;
      }
      if (now - lastFlush >= intervalMs) {
        clearPendingTimer();
        pending = false;
        lastFlush = now;
        flush();
        return;
      }
      pending = true;
      if (timer !== undefined) return;
      timer = clock.setTimer(flushPending, Math.max(0, intervalMs - (now - lastFlush)));
    },
    reset() {
      clearPendingTimer();
      pending = false;
      lastFlush = Number.NEGATIVE_INFINITY;
    },
  };
}

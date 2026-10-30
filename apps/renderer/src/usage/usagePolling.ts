import { USAGE_POLL_MS } from "./tokenUsage";

/**
 * Visibility-gated polling for `usage.get`.
 *
 * Every `usage.get` reaches the Host's Runtime entrypoint lookup, and before
 * P0-2 that meant re-hashing the installed Runtime. Polling a hidden or
 * minimised window is pure cost: nobody can read the card, and the window is
 * usually hidden for hours. So a hidden document does not poll at all, and
 * becoming visible refreshes immediately instead of waiting for the next tick
 * (the numbers on screen are the ones the user just came back to look at).
 *
 * Kept as a plain function so the timer/visibility rules are testable without a
 * React tree; the two call sites start it from their `useEffect`.
 */

export interface UsagePollingOptions {
  readonly load: () => void | Promise<void>;
  /** Defaults to `USAGE_POLL_MS`. */
  readonly intervalMs?: number;
  /** Defaults to `document.hidden`. */
  readonly isHidden?: () => boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. Defaults to `document`. */
  readonly onVisibilityChange?: (listener: () => void) => () => void;
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

function subscribeDocumentVisibility(listener: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", listener);
  return () => { document.removeEventListener("visibilitychange", listener); };
}

/**
 * Run `load` once now, then on every interval while the document is visible.
 * Returns a stop function that clears the timer and the visibility listener.
 */
export function startUsagePolling(options: UsagePollingOptions): () => void {
  const intervalMs = options.intervalMs ?? USAGE_POLL_MS;
  const isHidden = options.isHidden ?? documentHidden;
  const onVisibilityChange = options.onVisibilityChange ?? subscribeDocumentVisibility;
  let stopped = false;
  let busy = false;
  let hidden = isHidden();

  const run = (): void => {
    // A load slower than the interval must not stack a second request behind
    // itself; the next tick picks up after this one settles.
    if (stopped || busy) return;
    busy = true;
    let pending: void | Promise<void>;
    try {
      pending = options.load();
    } catch {
      busy = false;
      return;
    }
    // A synchronous load is already done; only a pending request keeps the
    // interval from starting another one.
    if (pending === undefined || typeof (pending as PromiseLike<void>).then !== "function") {
      busy = false;
      return;
    }
    void Promise.resolve(pending)
      .catch(() => undefined)
      .finally(() => { busy = false; });
  };

  const timer = window.setInterval(() => {
    if (isHidden()) return;
    run();
  }, intervalMs);

  const unsubscribe = onVisibilityChange(() => {
    if (stopped) return;
    const next = isHidden();
    if (next === hidden) return;
    hidden = next;
    if (!next) run();
  });

  run();
  return () => {
    stopped = true;
    window.clearInterval(timer);
    unsubscribe();
  };
}

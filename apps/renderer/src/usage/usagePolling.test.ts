import { afterEach, describe, expect, it, vi } from "vitest";

import { startUsagePolling } from "./usagePolling";

/**
 * P0-2 (renderer half): the 30 s `usage.get` poll must not run while the window
 * is hidden, and must refresh at once when it becomes visible again. Before this
 * change a minimised window kept asking the Host for usage - and each of those
 * lookups reached the Runtime installer's entrypoint verification.
 */

function visibilitySource(initiallyHidden = false) {
  let hidden = initiallyHidden;
  const listeners = new Set<() => void>();
  return {
    isHidden: () => hidden,
    onVisibilityChange: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next: boolean) {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
    get listeners() { return listeners.size; },
  };
}

function countingLoad() {
  const calls: number[] = [];
  return {
    calls,
    load: () => { calls.push(Date.now()); },
  };
}

describe("usage polling", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads once on mount and then on every interval while visible", () => {
    vi.useFakeTimers();
    const visibility = visibilitySource();
    const { calls, load } = countingLoad();
    const stop = startUsagePolling({ load, isHidden: visibility.isHidden, onVisibilityChange: visibility.onVisibilityChange });

    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(30_000);
    expect(calls).toHaveLength(3);
    stop();
  });

  it("stops polling while the document is hidden and refreshes as soon as it is visible", () => {
    vi.useFakeTimers();
    const visibility = visibilitySource();
    const { calls, load } = countingLoad();
    const stop = startUsagePolling({ load, isHidden: visibility.isHidden, onVisibilityChange: visibility.onVisibilityChange });
    expect(calls).toHaveLength(1);

    visibility.set(true);
    // Two minutes hidden: no request at all, not four no-ops that still cost a
    // Host round trip.
    vi.advanceTimersByTime(120_000);
    expect(calls).toHaveLength(1);

    visibility.set(false);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(30_000);
    expect(calls).toHaveLength(3);
    stop();
  });

  it("refreshes on return even when the timer that fired while hidden was skipped", () => {
    vi.useFakeTimers();
    const visibility = visibilitySource(true);
    const { calls, load } = countingLoad();
    // A window that first mounts hidden still shows data when it opens, so the
    // mount fetch runs; what must not happen is a hidden interval firing.
    const stop = startUsagePolling({ load, isHidden: visibility.isHidden, onVisibilityChange: visibility.onVisibilityChange });
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(90_000);
    expect(calls).toHaveLength(1);
    visibility.set(false);
    expect(calls).toHaveLength(2);
    stop();
  });

  it("does not stack requests when a load takes longer than the interval", async () => {
    vi.useFakeTimers();
    const visibility = visibilitySource();
    const calls: number[] = [];
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const stop = startUsagePolling({
      load: () => { calls.push(Date.now()); return pending; },
      isHidden: visibility.isHidden,
      onVisibilityChange: visibility.onVisibilityChange,
    });
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(90_000);
    expect(calls).toHaveLength(1);
    release();
    await pending;
    await Promise.resolve();
    vi.advanceTimersByTime(30_000);
    expect(calls).toHaveLength(2);
    stop();
  });

  it("releases the interval and the visibility listener when stopped", () => {
    vi.useFakeTimers();
    const visibility = visibilitySource();
    const { calls, load } = countingLoad();
    const stop = startUsagePolling({ load, isHidden: visibility.isHidden, onVisibilityChange: visibility.onVisibilityChange });
    expect(visibility.listeners).toBe(1);
    stop();
    expect(visibility.listeners).toBe(0);
    vi.advanceTimersByTime(120_000);
    visibility.set(true);
    visibility.set(false);
    expect(calls).toHaveLength(1);
  });

  it("defaults to document.hidden", () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { calls, load } = countingLoad();
    const stop = startUsagePolling({ load });
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(90_000);
    expect(calls).toHaveLength(1);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(2);
    stop();
    expect(calls).toHaveLength(2);
  });
});

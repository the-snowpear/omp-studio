import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SessionId, SessionTelemetryReadResult, SessionTelemetrySnapshot, SessionTelemetrySource } from "@omp-studio/studio-protocol";
import { preferFresherTelemetry, useViewedSessionTelemetry, type ViewedTelemetryClient, type ViewedSessionTelemetryState } from "./useViewedSessionTelemetry";

function snapshot(sessionId: string, total: number, capturedAt = "2026-08-16T00:00:00.000Z"): SessionTelemetrySnapshot {
  return {
    sessionId: sessionId as SessionId,
    capturedAt,
    tokens: { input: total, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: total + 1, cost: 0 },
    context: null,
    unavailableReason: "model_context_unknown",
  };
}

function readResult(sessionId: string, source: SessionTelemetrySource, total: number): SessionTelemetryReadResult {
  return { sessionId: sessionId as SessionId, source, semantics: "last-observed", telemetry: snapshot(sessionId, total) };
}

class FakeClient {
  readonly calls: string[] = [];
  private readonly pending: Array<(result: SessionTelemetryReadResult) => void> = [];

  constructor(private readonly failAll = false) {}

  get queries(): ViewedTelemetryClient {
    return {
      query: async (_name: "session.telemetry.read", input: { sessionId: SessionId }) => {
        this.calls.push(input.sessionId);
        return await new Promise<SessionTelemetryReadResult>((resolve, reject) => {
          this.pending.push((result) => {
            if (this.failAll) reject({ code: "UNAVAILABLE", message: "no" });
            else resolve(result);
          });
        });
      },
    } as unknown as ViewedTelemetryClient;
  }

  resolveNext(result: SessionTelemetryReadResult): void {
    this.pending.shift()?.(result);
  }
}

interface ProbeProps {
  readonly client: ViewedTelemetryClient | null;
  readonly preview: boolean;
  readonly viewedSessionId: SessionId | undefined;
  readonly liveSessionId: SessionId | undefined;
  readonly liveTelemetry: SessionTelemetrySnapshot | undefined;
  readonly refreshToken?: number;
}

function mountHook(initial: ProbeProps): {
  readonly states: ViewedSessionTelemetryState[];
  rerender(props: ProbeProps): void;
} {
  const states: ViewedSessionTelemetryState[] = [];
  const Probe = (props: ProbeProps) => {
    const state = useViewedSessionTelemetry(props);
    states.push(state);
    return null;
  };
  const view = render(<Probe {...initial} />);
  return {
    states,
    rerender(props: ProbeProps) {
      act(() => {
        view.rerender(<Probe {...props} />);
      });
    },
  };
}

const tick = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("useViewedSessionTelemetry", () => {
  it("never queries in preview mode and reports the preview status", async () => {
    const client = new FakeClient();
    const harness = mountHook({
      client: client.queries,
      preview: true,
      viewedSessionId: "session-a" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: undefined,
    });
    await tick();
    expect(harness.states.at(-1)?.status).toBe("preview");
    expect(client.calls).toEqual([]);
  });

  it("uses live entities when viewing the live session", async () => {
    const client = new FakeClient();
    const harness = mountHook({
      client: client.queries,
      preview: false,
      viewedSessionId: "session-live" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: snapshot("session-live", 42),
    });
    await tick();
    const state = harness.states.at(-1);
    expect(state?.status).toBe("live");
    expect(state?.source).toBe("live");
    expect(state?.telemetry?.tokens.input).toBe(42);
    expect(client.calls).toEqual([]);
  });

  it("queries archived sessions, discards stale generations, and caches completed results", async () => {
    const client = new FakeClient();
    const base = {
      client: client.queries,
      preview: false,
      viewedSessionId: "session-a" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: snapshot("session-live", 1) as SessionTelemetrySnapshot | undefined,
    };
    const harness = mountHook(base);
    await tick();
    expect(harness.states.at(-1)?.status).toBe("loading");
    expect(client.calls).toEqual(["session-a"]);

    // Switch sessions mid-flight; the late result for session-a must be dropped.
    harness.rerender({ ...base, viewedSessionId: "session-b" as SessionId });
    await tick();
    expect(client.calls).toEqual(["session-a", "session-b"]);
    client.resolveNext(readResult("session-a", "persisted", 10));
    await tick();
    expect(harness.states.at(-1)?.status).toBe("loading");

    client.resolveNext(readResult("session-b", "archive-recomputed", 20));
    await tick();
    const ready = harness.states.at(-1);
    expect(ready?.status).toBe("ready");
    expect(ready?.source).toBe("archive-recomputed");
    expect(ready?.telemetry?.tokens.input).toBe(20);

    // Switch to live and back: the cached result is reused without a new query.
    harness.rerender({ ...base, viewedSessionId: "session-live" as SessionId });
    await tick();
    expect(harness.states.at(-1)?.status).toBe("live");
    harness.rerender(base);
    await tick();
    expect(client.calls).toEqual(["session-a", "session-b"]);
    const cached = harness.states.at(-1);
    expect(cached?.status).toBe("ready");
    expect(cached?.telemetry?.tokens.input).toBe(10);
    // session-b stays cached under its own id.
    harness.rerender({ ...base, viewedSessionId: "session-b" as SessionId });
    await tick();
    expect(client.calls).toEqual(["session-a", "session-b"]);
    expect(harness.states.at(-1)?.telemetry?.tokens.input).toBe(20);
  });

  it("reports an honest unavailable state when the query fails", async () => {
    const client = new FakeClient(true);
    const harness = mountHook({
      client: client.queries,
      preview: false,
      viewedSessionId: "session-a" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: snapshot("session-live", 1),
    });
    await tick();
    client.resolveNext(readResult("session-a", "persisted", 1));
    await tick();
    expect(harness.states.at(-1)?.status).toBe("unavailable");
  });

  it("lets live data immediately override an offline result when the runtime resumes the session", async () => {
    const client = new FakeClient();
    const base = {
      client: client.queries,
      preview: false,
      viewedSessionId: "session-a" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: undefined as SessionTelemetrySnapshot | undefined,
    };
    const harness = mountHook(base);
    await tick();
    client.resolveNext(readResult("session-a", "persisted", 10));
    await tick();
    expect(harness.states.at(-1)?.status).toBe("ready");
    harness.rerender({ ...base, liveSessionId: "session-a" as SessionId, liveTelemetry: snapshot("session-a", 99) });
    await tick();
    const state = harness.states.at(-1);
    expect(state?.status).toBe("live");
    expect(state?.source).toBe("live");
    expect(state?.telemetry?.tokens.input).toBe(99);
  });

  it("re-reads archived telemetry when refreshToken increments instead of serving the cache", async () => {
    const client = new FakeClient();
    const base = {
      client: client.queries,
      preview: false,
      viewedSessionId: "session-a" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: undefined as SessionTelemetrySnapshot | undefined,
    };
    const harness = mountHook(base);
    await tick();
    client.resolveNext(readResult("session-a", "persisted", 10));
    await tick();
    expect(harness.states.at(-1)?.telemetry?.tokens.input).toBe(10);
    expect(client.calls).toEqual(["session-a"]);

    harness.rerender({ ...base, refreshToken: 1 });
    await tick();
    expect(client.calls).toEqual(["session-a", "session-a"]);
    client.resolveNext(readResult("session-a", "archive-recomputed", 3));
    await tick();
    expect(harness.states.at(-1)?.status).toBe("ready");
    expect(harness.states.at(-1)?.source).toBe("archive-recomputed");
    expect(harness.states.at(-1)?.telemetry?.tokens.input).toBe(3);
  });

  it("re-reads live Context after refreshToken and keeps the newer capturedAt snapshot", async () => {
    const client = new FakeClient();
    const live = snapshot("session-live", 42, "2026-08-16T00:00:00.000Z");
    const harness = mountHook({
      client: client.queries,
      preview: false,
      viewedSessionId: "session-live" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: live,
    });
    await tick();
    expect(client.calls).toEqual([]);

    harness.rerender({
      client: client.queries,
      preview: false,
      viewedSessionId: "session-live" as SessionId,
      liveSessionId: "session-live" as SessionId,
      liveTelemetry: live,
      refreshToken: 1,
    });
    await tick();
    expect(client.calls).toEqual(["session-live"]);
    client.resolveNext({
      sessionId: "session-live" as SessionId,
      source: "live",
      semantics: "current-live",
      telemetry: snapshot("session-live", 7, "2026-08-16T00:01:00.000Z"),
    });
    await tick();
    const state = harness.states.at(-1);
    expect(state?.status).toBe("live");
    expect(state?.telemetry?.tokens.input).toBe(7);
  });
});

describe("preferFresherTelemetry", () => {
  it("keeps live when the read is older or missing a usable timestamp", () => {
    const live = snapshot("s", 10, "2026-08-16T00:02:00.000Z");
    const older = snapshot("s", 99, "2026-08-16T00:01:00.000Z");
    expect(preferFresherTelemetry(live, older)).toBe(live);
    expect(preferFresherTelemetry(live, undefined)).toBe(live);
    expect(preferFresherTelemetry(undefined, older)).toBe(older);
  });
});

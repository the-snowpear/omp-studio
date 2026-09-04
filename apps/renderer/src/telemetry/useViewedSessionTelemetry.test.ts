// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionId, SessionTelemetryReadResult, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";

import { useViewedSessionTelemetry, type ViewedTelemetryClient } from "./useViewedSessionTelemetry";

afterEach(cleanup);

const sessionId = (value: string) => value as SessionId;

function telemetry(id: SessionId, capturedAt = "2026-08-31T00:00:00.000Z"): SessionTelemetrySnapshot {
  return {
    sessionId: id,
    capturedAt,
    tokens: { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 0, total: 14, cost: 0.12 },
    context: {
      contextWindow: 128_000,
      usedTokens: 2_400,
      percent: 1.875,
      anchored: false,
      systemPromptTokens: 100,
      systemContextTokens: 200,
      systemToolsTokens: 300,
      skillsTokens: 400,
      messagesTokens: 1_400,
    },
  };
}

function result(id: SessionId, capturedAt?: string): SessionTelemetryReadResult {
  return {
    sessionId: id,
    source: "persisted",
    semantics: "last-observed",
    telemetry: telemetry(id, capturedAt),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("useViewedSessionTelemetry", () => {
  it("does not read archived telemetry until a Token/Context surface is opened", async () => {
    const archived = sessionId("session-archived");
    const query = vi.fn().mockResolvedValue(result(archived));
    const client = { query } as ViewedTelemetryClient;
    const hook = renderHook(({ enabled }) => useViewedSessionTelemetry({
      client,
      preview: false,
      enabled,
      viewedSessionId: archived,
      liveSessionId: sessionId("session-live"),
      liveTelemetry: undefined,
    }), { initialProps: { enabled: false } });

    expect(hook.result.current.status).toBe("idle");
    expect(query).not.toHaveBeenCalled();

    hook.rerender({ enabled: true });
    expect(hook.result.current.status).toBe("loading");
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(query).toHaveBeenCalledTimes(1);

    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("joins the same in-flight read when a panel is closed and reopened", async () => {
    const archived = sessionId("session-archived");
    const pending = deferred<SessionTelemetryReadResult>();
    const query = vi.fn().mockReturnValue(pending.promise);
    const client = { query } as ViewedTelemetryClient;
    const hook = renderHook(({ enabled }) => useViewedSessionTelemetry({
      client,
      preview: false,
      enabled,
      viewedSessionId: archived,
      liveSessionId: sessionId("session-live"),
      liveTelemetry: undefined,
    }), { initialProps: { enabled: true } });

    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(query).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(result(archived)));
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not apply a late result from the previously viewed session", async () => {
    const first = sessionId("session-first");
    const second = sessionId("session-second");
    const firstRead = deferred<SessionTelemetryReadResult>();
    const secondRead = deferred<SessionTelemetryReadResult>();
    const query = vi.fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);
    const client = { query } as ViewedTelemetryClient;
    const hook = renderHook(({ viewedSessionId }) => useViewedSessionTelemetry({
      client,
      preview: false,
      enabled: true,
      viewedSessionId,
      liveSessionId: sessionId("session-live"),
      liveTelemetry: undefined,
    }), { initialProps: { viewedSessionId: first } });

    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));
    hook.rerender({ viewedSessionId: second });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));

    await act(async () => firstRead.resolve(result(first)));
    expect(hook.result.current.status).toBe("loading");
    expect(hook.result.current.telemetry).toBeUndefined();

    await act(async () => secondRead.resolve(result(second)));
    await waitFor(() => expect(hook.result.current.telemetry?.sessionId).toBe(second));
  });

  it("keeps live telemetry available while demand is disabled", () => {
    const live = sessionId("session-live");
    const query = vi.fn();
    const snapshot = telemetry(live);
    const hook = renderHook(() => useViewedSessionTelemetry({
      client: { query } as ViewedTelemetryClient,
      preview: false,
      enabled: false,
      viewedSessionId: live,
      liveSessionId: live,
      liveTelemetry: snapshot,
    }));

    expect(hook.result.current).toEqual({ status: "live", source: "live", telemetry: snapshot });
    expect(query).not.toHaveBeenCalled();
  });

  it("refreshes once per token only after demand is enabled", async () => {
    const archived = sessionId("session-archived");
    const query = vi.fn()
      .mockResolvedValueOnce(result(archived, "2026-08-31T00:00:00.000Z"))
      .mockResolvedValueOnce(result(archived, "2026-08-31T00:01:00.000Z"));
    const client = { query } as ViewedTelemetryClient;
    const hook = renderHook(({ enabled, refreshToken }) => useViewedSessionTelemetry({
      client,
      preview: false,
      enabled,
      viewedSessionId: archived,
      liveSessionId: sessionId("session-live"),
      liveTelemetry: undefined,
      refreshToken,
    }), { initialProps: { enabled: true, refreshToken: 0 } });

    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(query).toHaveBeenCalledTimes(1);

    hook.rerender({ enabled: false, refreshToken: 1 });
    expect(query).toHaveBeenCalledTimes(1);
    hook.rerender({ enabled: true, refreshToken: 1 });
    await waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hook.result.current.telemetry?.capturedAt).toBe("2026-08-31T00:01:00.000Z"));

    hook.rerender({ enabled: false, refreshToken: 1 });
    hook.rerender({ enabled: true, refreshToken: 1 });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

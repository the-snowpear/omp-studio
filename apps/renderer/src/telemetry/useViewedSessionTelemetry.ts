import { useEffect, useRef, useState } from "react";

import type { SessionId, SessionTelemetryReadResult, SessionTelemetrySnapshot, SessionTelemetrySource } from "@omp-studio/studio-protocol";

/**
 * Client surface consumed by the offline telemetry hook. Structural so tests
 * can pass a plain object without constructing a full StudioClient.
 */
export type ViewedTelemetryClient = {
  query(name: "session.telemetry.read", input: { readonly sessionId: SessionId }): Promise<SessionTelemetryReadResult>;
};

export type ViewedSessionTelemetryStatus = "preview" | "live" | "loading" | "ready" | "unavailable";

export interface ViewedSessionTelemetryState {
  readonly status: ViewedSessionTelemetryStatus;
  /** Provenance of the last applied telemetry; absent while not ready. */
  readonly source?: SessionTelemetrySource;
  readonly telemetry?: SessionTelemetrySnapshot;
}

interface CachedResult {
  readonly source: SessionTelemetrySource;
  readonly telemetry: SessionTelemetrySnapshot;
}

const IDENTITY = { status: "preview" } as const;

export function useViewedSessionTelemetry(options: {
  /** Real client; `null` in preview mode so no query is ever issued. */
  readonly client: ViewedTelemetryClient | null;
  /** Preview switch: fixtures only, no real reads. */
  readonly preview: boolean;
  /** Session being viewed; `undefined` means the live/current thread. */
  readonly viewedSessionId: SessionId | undefined;
  readonly liveSessionId: SessionId | undefined;
  readonly liveTelemetry: SessionTelemetrySnapshot | undefined;
}): ViewedSessionTelemetryState {
  const { client, preview, viewedSessionId, liveSessionId, liveTelemetry } = options;
  const generationRef = useRef(0);
  /** Completed results cached per sessionId for this page lifecycle. */
  const cacheRef = useRef(new Map<string, CachedResult>());
  const [offline, setOffline] = useState<{ sessionId: string; result: CachedResult } | { sessionId: string; failed: true } | undefined>();

  const viewingLive = viewedSessionId === undefined || viewedSessionId === liveSessionId;

  useEffect(() => {
    if (preview || viewingLive || client === null || viewedSessionId === undefined) {
      return;
    }
    const generation = ++generationRef.current;
    const cached = cacheRef.current.get(viewedSessionId);
    if (cached !== undefined) {
      setOffline({ sessionId: viewedSessionId, result: cached });
      return;
    }
    setOffline(undefined);
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.query("session.telemetry.read", { sessionId: viewedSessionId });
        // A completed result is valid for its sessionId even if the user
        // navigated away; only applying it to the view is generation-gated.
        const entry: CachedResult = { source: result.source, telemetry: result.telemetry };
        cacheRef.current.set(viewedSessionId, entry);
        if (cancelled || generation !== generationRef.current) return;
        setOffline({ sessionId: viewedSessionId, result: entry });
      } catch {
        if (cancelled || generation !== generationRef.current) return;
        setOffline({ sessionId: viewedSessionId, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, preview, viewingLive, viewedSessionId]);

  if (preview) return IDENTITY;
  if (viewingLive) {
    return { status: "live", ...(liveTelemetry === undefined ? {} : { source: "live" as const, telemetry: liveTelemetry }) };
  }
  if (offline === undefined || offline.sessionId !== viewedSessionId) return { status: "loading" };
  if ("failed" in offline) return { status: "unavailable" };
  return { status: "ready", source: offline.result.source, telemetry: offline.result.telemetry };
}

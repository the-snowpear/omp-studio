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

/** Prefer the snapshot that was captured later. Equal/invalid timestamps keep `live`. */
export function preferFresherTelemetry(
  live: SessionTelemetrySnapshot | undefined,
  read: SessionTelemetrySnapshot | undefined,
): SessionTelemetrySnapshot | undefined {
  if (live === undefined) return read;
  if (read === undefined) return live;
  const liveAt = Date.parse(live.capturedAt);
  const readAt = Date.parse(read.capturedAt);
  if (Number.isNaN(readAt) || readAt <= liveAt) return live;
  return read;
}

export function useViewedSessionTelemetry(options: {
  /** Real client; `null` in preview mode so no query is ever issued. */
  readonly client: ViewedTelemetryClient | null;
  /** Preview switch: fixtures only, no real reads. */
  readonly preview: boolean;
  /** Session being viewed; `undefined` means the live/current thread. */
  readonly viewedSessionId: SessionId | undefined;
  readonly liveSessionId: SessionId | undefined;
  readonly liveTelemetry: SessionTelemetrySnapshot | undefined;
  /**
   * Bump after a mutation that invalidates last-read Context (e.g. compact).
   * Archived cache is dropped; live views also re-query `session.telemetry.read`.
   */
  readonly refreshToken?: number;
}): ViewedSessionTelemetryState {
  const { client, preview, viewedSessionId, liveSessionId, liveTelemetry } = options;
  const refreshToken = options.refreshToken ?? 0;
  const generationRef = useRef(0);
  /** Completed results cached per sessionId for this page lifecycle. */
  const cacheRef = useRef(new Map<string, CachedResult>());
  const [offline, setOffline] = useState<{ sessionId: string; result: CachedResult } | { sessionId: string; failed: true } | undefined>();

  const viewingLive = viewedSessionId === undefined || viewedSessionId === liveSessionId;
  const targetSessionId = viewedSessionId ?? (viewingLive ? liveSessionId : undefined);

  useEffect(() => {
    if (preview || client === null || targetSessionId === undefined) return;
    const shouldQuery = !viewingLive || refreshToken > 0;
    if (!shouldQuery) return;
    const generation = ++generationRef.current;
    const cached = refreshToken === 0 ? cacheRef.current.get(targetSessionId) : undefined;
    if (cached !== undefined) {
      setOffline({ sessionId: targetSessionId, result: cached });
      return;
    }
    if (refreshToken > 0) cacheRef.current.delete(targetSessionId);
    if (!viewingLive) setOffline(undefined);
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.query("session.telemetry.read", { sessionId: targetSessionId });
        // A completed result is valid for its sessionId even if the user
        // navigated away; only applying it to the view is generation-gated.
        const entry: CachedResult = { source: result.source, telemetry: result.telemetry };
        cacheRef.current.set(targetSessionId, entry);
        if (cancelled || generation !== generationRef.current) return;
        setOffline({ sessionId: targetSessionId, result: entry });
      } catch {
        if (cancelled || generation !== generationRef.current) return;
        setOffline({ sessionId: targetSessionId, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, preview, viewingLive, targetSessionId, refreshToken]);

  if (preview) return IDENTITY;
  const read = offline !== undefined && offline.sessionId === targetSessionId && !("failed" in offline)
    ? offline.result
    : undefined;
  if (viewingLive) {
    const telemetry = preferFresherTelemetry(liveTelemetry, read?.telemetry);
    if (telemetry === undefined) return { status: "live" };
    const fromRead = read !== undefined && telemetry === read.telemetry;
    return { status: "live", source: fromRead ? read.source : "live", telemetry };
  }
  if (offline === undefined || offline.sessionId !== viewedSessionId) return { status: "loading" };
  if ("failed" in offline) return { status: "unavailable" };
  return { status: "ready", source: offline.result.source, telemetry: offline.result.telemetry };
}

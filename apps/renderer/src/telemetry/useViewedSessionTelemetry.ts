import { useEffect, useRef, useState } from "react";

import type { SessionId, SessionTelemetryReadResult, SessionTelemetrySnapshot, SessionTelemetrySource } from "@omp-studio/studio-protocol";

/**
 * Client surface consumed by the offline telemetry hook. Structural so tests
 * can pass a plain object without constructing a full StudioClient.
 */
export type ViewedTelemetryClient = {
  query(name: "session.telemetry.read", input: { readonly sessionId: SessionId }): Promise<SessionTelemetryReadResult>;
};

export type ViewedSessionTelemetryStatus = "preview" | "live" | "idle" | "loading" | "ready" | "unavailable";

export interface ViewedSessionTelemetryState {
  readonly status: ViewedSessionTelemetryStatus;
  /** Provenance of the last applied telemetry; absent while not ready. */
  readonly source?: SessionTelemetrySource;
  readonly telemetry?: SessionTelemetrySnapshot;
}

interface CachedResult {
  readonly source: SessionTelemetrySource;
  readonly telemetry: SessionTelemetrySnapshot;
  readonly refreshToken: number;
}

interface InFlightRead {
  readonly refreshToken: number;
  readonly promise: Promise<CachedResult>;
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

/** 按会话缓存的 telemetry 快照上限。只有当前在看的那个需要命中，留少量余量给来回切换。 */
const VIEWED_TELEMETRY_CACHE_MAX = 8;

export function useViewedSessionTelemetry(options: {
  /** Real client; `null` in preview mode so no query is ever issued. */
  readonly client: ViewedTelemetryClient | null;
  /** Preview switch: fixtures only, no real reads. */
  readonly preview: boolean;
  /**
   * Expensive archive reads are demand-driven. Keep this false until the user
   * opens a Token/Context surface; live telemetry remains available regardless.
   */
  readonly enabled: boolean;
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
  const { client, preview, enabled, viewedSessionId, liveSessionId, liveTelemetry } = options;
  const refreshToken = options.refreshToken ?? 0;
  const generationRef = useRef(0);
  /** Completed results cached per sessionId for this page lifecycle, LRU-capped. */
  const cacheRef = useRef(new Map<string, CachedResult>());
  /** Closing/reopening a panel joins the existing Host read instead of probing twice. */
  const inFlightRef = useRef(new Map<string, InFlightRead>());
  const [offline, setOffline] = useState<{ sessionId: string; result: CachedResult } | { sessionId: string; failed: true } | undefined>();

  const viewingLive = viewedSessionId === undefined || viewedSessionId === liveSessionId;
  const targetSessionId = viewedSessionId ?? (viewingLive ? liveSessionId : undefined);

  useEffect(() => {
    if (!enabled || preview || client === null || targetSessionId === undefined) return;
    const shouldQuery = !viewingLive || refreshToken > 0;
    if (!shouldQuery) return;
    const generation = ++generationRef.current;
    const cachedEntry = cacheRef.current.get(targetSessionId);
    const cached = cachedEntry?.refreshToken === refreshToken ? cachedEntry : undefined;
    if (cached !== undefined) {
      // Touch the entry so the cap is a real LRU rather than insertion order.
      cacheRef.current.delete(targetSessionId);
      cacheRef.current.set(targetSessionId, cached);
      setOffline({ sessionId: targetSessionId, result: cached });
      return;
    }
    cacheRef.current.delete(targetSessionId);
    if (!viewingLive) setOffline(undefined);
    let cancelled = false;
    void (async () => {
      try {
        const existing = inFlightRef.current.get(targetSessionId);
        let request = existing?.refreshToken === refreshToken ? existing : undefined;
        if (request === undefined) {
          const promise = client.query("session.telemetry.read", { sessionId: targetSessionId }).then((result) => {
            const entry: CachedResult = { source: result.source, telemetry: result.telemetry, refreshToken };
            // A superseded refresh must not overwrite its newer result. A read
            // completed after navigation is still useful in the bounded cache.
            if (inFlightRef.current.get(targetSessionId)?.promise === promise) {
              cacheRef.current.set(targetSessionId, entry);
              while (cacheRef.current.size > VIEWED_TELEMETRY_CACHE_MAX) {
                const oldest = cacheRef.current.keys().next().value;
                if (oldest === undefined) break;
                cacheRef.current.delete(oldest);
              }
            }
            return entry;
          }).finally(() => {
            if (inFlightRef.current.get(targetSessionId)?.promise === promise) {
              inFlightRef.current.delete(targetSessionId);
            }
          });
          request = { refreshToken, promise };
          inFlightRef.current.set(targetSessionId, request);
        }
        const entry = await request.promise;
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
  }, [client, enabled, preview, viewingLive, targetSessionId, refreshToken]);

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
  if (offline === undefined || offline.sessionId !== viewedSessionId) {
    return { status: enabled ? "loading" : "idle" };
  }
  if ("failed" in offline) return { status: "unavailable" };
  return { status: "ready", source: offline.result.source, telemetry: offline.result.telemetry };
}

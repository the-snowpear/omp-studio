import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  formatElapsed,
  formatRetry,
  isLiveActivityPhase,
  reduceActivityRetry,
  reduceAwaitingTurn,
  reduceRunStreaming,
  syncRunWindow,
  WORKING_LABEL,
  type ActivityRetry,
  type ActivityStatus,
  type RunTrust,
} from "./activityStatus";

/** Survives WorkbenchCanvas unmount when the operator leaves for Home. */
const runWindowStore = new Map<string, number>();

/**
 * Start moment of the current run window. Token accounting stays in telemetry;
 * the activity line itself only shows working / elapsed / the live operation.
 * The clock is keyed by session identity so homepage ↔ desktop remounts keep
 * the same elapsed time.
 */
export function useRunWindow(active: boolean, identityKey: string): { readonly startedAt: number | null } {
  return { startedAt: syncRunWindow(identityKey, active, Date.now(), runWindowStore) };
}

/**
 * True from the moment a prompt is in flight until the run ends. Survives the
 * gap after the optimistic user row is reconciled and before `isStreaming`.
 * `cancelGeneration` rises on an accepted user abort.
 */
export function useAwaitingTurn(input: {
  sending: boolean;
  pending: boolean;
  streaming: boolean;
  failed: boolean;
  identityKey: string;
  cancelGeneration?: number;
}): boolean {
  const ref = useRef({ identityKey: input.identityKey, latched: false, wasStreaming: false, cancelGeneration: 0 });
  if (ref.current.identityKey !== input.identityKey) {
    ref.current = { identityKey: input.identityKey, latched: false, wasStreaming: false, cancelGeneration: 0 };
  }
  const next = reduceAwaitingTurn(
    { latched: ref.current.latched, wasStreaming: ref.current.wasStreaming, cancelGeneration: ref.current.cancelGeneration },
    {
      sending: input.sending,
      pending: input.pending,
      streaming: input.streaming,
      failed: input.failed,
      ...(input.cancelGeneration === undefined ? {} : { cancelGeneration: input.cancelGeneration }),
    },
  );
  ref.current.latched = next.latched;
  ref.current.wasStreaming = next.wasStreaming;
  ref.current.cancelGeneration = next.cancelGeneration;
  return next.latched;
}

/**
 * The run signal every write surface (activity line, stop button, queue flush)
 * reads. `settled` is the Runtime's own "this run is over" verdict — the moment
 * to reconcile client-side live state the Runtime will never close itself.
 */
export function useRunStreaming(input: {
  identityKey: string;
  runtimeStreaming: boolean;
  conversationLive: boolean;
}): { readonly streaming: boolean; readonly settled: boolean } {
  const ref = useRef<{ identityKey: string; trust: RunTrust; conversationLive: boolean }>({
    identityKey: input.identityKey,
    trust: "early",
    conversationLive: false,
  });
  const next = reduceRunStreaming(ref.current, input);
  ref.current = { identityKey: next.identityKey, trust: next.trust, conversationLive: next.conversationLive };
  return { streaming: next.streaming, settled: next.settled };
}

/**
 * Outstanding auto-retry for the current run. Survives the backoff gap after
 * `isStreaming` falls and before the next attempt starts.
 */
export function useActivityRetry(input: {
  notices: readonly { message: string; source?: string }[];
  streaming: boolean;
  failed: boolean;
  identityKey: string;
  cancelGeneration?: number;
}): ActivityRetry | undefined {
  const ref = useRef<{
    identityKey: string;
    retry?: ActivityRetry;
    noticeCount: number;
    endCount: number;
    cancelGeneration: number;
    seenStream: boolean;
    wasStreaming: boolean;
  }>({
    identityKey: input.identityKey,
    noticeCount: 0,
    endCount: 0,
    cancelGeneration: 0,
    seenStream: false,
    wasStreaming: false,
  });
  const next = reduceActivityRetry(ref.current, {
    identityKey: input.identityKey,
    notices: input.notices,
    streaming: input.streaming,
    failed: input.failed,
    ...(input.cancelGeneration === undefined ? {} : { cancelGeneration: input.cancelGeneration }),
  });
  ref.current = {
    identityKey: next.identityKey,
    noticeCount: next.noticeCount,
    endCount: next.endCount,
    cancelGeneration: next.cancelGeneration,
    seenStream: next.seenStream,
    wasStreaming: next.wasStreaming,
    ...(next.retry === undefined ? {} : { retry: next.retry }),
  };
  return next.retry;
}

/** Wall-clock ms since `startedAt`, re-rendered once per second. */
function useElapsed(startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

/**
 * Bottom-of-transcript run status. Waiting for the first assistant event shows
 * only "working"; an outstanding auto-retry joins immediately to its right as
 * `Retry N/M`. Once a response starts, the retry drops and the line is
 * `working · elapsed · operation`. No chrome, no stop control — abort stays
 * on the composer.
 */
export function ActivityLine({
  status,
  startedAt,
  demo,
}: {
  status: ActivityStatus;
  /** Epoch ms when the current run began; omitted until the clock should count. */
  startedAt?: number;
  /** Preview mode: data comes from fixtures. */
  demo?: boolean;
}) {
  const elapsed = useElapsed(startedAt);
  const live = isLiveActivityPhase(status.phase);
  const showOperation = live || status.phase === "queued" || (status.phase === "waiting" && status.label !== WORKING_LABEL);

  return (
    <div className="activity-line" data-phase={status.phase}>
      <span className="al-glyph" aria-hidden="true">
        <Icon name="asterisk" extra="sm" />
      </span>
      <span className="al-text" role="status" aria-live="polite">
        <span className="al-label">{WORKING_LABEL}</span>
        {status.retry === undefined || live ? null : (
          <>
            <span className="al-sep">·</span>
            <span className="al-retry">{formatRetry(status.retry)}</span>
          </>
        )}
        {live && startedAt !== undefined ? (
          <>
            <span className="al-sep">·</span>
            <span className="al-elapsed">{formatElapsed(elapsed)}</span>
          </>
        ) : null}
        {showOperation ? (
          <>
            <span className="al-sep">·</span>
            <span className="al-op">{status.label}</span>
            {status.detail === undefined ? null : <span className="al-detail mono">{status.detail}</span>}
          </>
        ) : null}
      </span>
      {demo === true ? <span className="chip gray xs">演示</span> : null}
    </div>
  );
}

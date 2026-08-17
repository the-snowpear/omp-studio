import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import {
  formatElapsed,
  isLiveActivityPhase,
  reduceAwaitingTurn,
  WORKING_LABEL,
  type ActivityStatus,
} from "./activityStatus";

/**
 * Start moment of the current run window. Token accounting stays in telemetry;
 * the activity line itself only shows working / elapsed / the live operation.
 */
export function useRunWindow(active: boolean): { readonly startedAt: number | null } {
  const [startedAt, setStartedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      setStartedAt(null);
      return;
    }
    setStartedAt((previous) => previous ?? Date.now());
  }, [active]);

  return { startedAt };
}

/**
 * True from the moment a prompt is in flight until the run ends. Survives the
 * gap after the optimistic user row is reconciled and before `isStreaming`.
 */
export function useAwaitingTurn(input: {
  sending: boolean;
  pending: boolean;
  streaming: boolean;
  failed: boolean;
  identityKey: string;
}): boolean {
  const ref = useRef({ identityKey: input.identityKey, latched: false, wasStreaming: false });
  if (ref.current.identityKey !== input.identityKey) {
    ref.current = { identityKey: input.identityKey, latched: false, wasStreaming: false };
  }
  const next = reduceAwaitingTurn(
    { latched: ref.current.latched, wasStreaming: ref.current.wasStreaming },
    {
      sending: input.sending,
      pending: input.pending,
      streaming: input.streaming,
      failed: input.failed,
    },
  );
  ref.current.latched = next.latched;
  ref.current.wasStreaming = next.wasStreaming;
  return next.latched;
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
 * only "working"; once a response starts, elapsed time and the live operation
 * join the line. No chrome, no stop control — abort stays on the composer.
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

  return (
    <div className="activity-line" data-phase={status.phase}>
      <span className="al-glyph" aria-hidden="true">
        <Icon name="asterisk" extra="sm" />
      </span>
      <span className="al-text" role="status" aria-live="polite">
        <span className="al-label">{WORKING_LABEL}</span>
        {live && startedAt !== undefined ? (
          <>
            <span className="al-sep">·</span>
            <span className="al-elapsed">{formatElapsed(elapsed)}</span>
          </>
        ) : null}
        {live || status.phase === "queued" ? (
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

import { useEffect, useState } from "react";
import type { BtwSnapshot, BtwStatus } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { formatElapsed } from "../conversation/activityStatus";

const LABELS: Readonly<Record<BtwStatus, string>> = {
  running: "正在回答",
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
};

/** The Runtime's own wording is an English contract string; label it in place. */
function failureLabel(snapshot: BtwSnapshot): string {
  return snapshot.error?.code === "OUTPUT_LIMIT" ? "超出输出上限" : LABELS.failed;
}

export function btwStatusLabel(snapshot: BtwSnapshot | null): string {
  if (snapshot === null) return "待提问";
  if (snapshot.status === "failed") return failureLabel(snapshot);
  return LABELS[snapshot.status];
}

/**
 * Elapsed ms that stops ticking once the round is over.
 *
 * The main activity line's clock only exists while a run is live, so it can tick
 * unconditionally; a BTW round stays on screen after it finishes and has to
 * freeze its total instead of counting up forever.
 */
function useFrozenElapsed(startedAt: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null || !running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  const [frozen, setFrozen] = useState<number | null>(null);
  useEffect(() => {
    if (startedAt === null) {
      setFrozen(null);
      return;
    }
    if (running) return;
    setFrozen(Math.max(0, Date.now() - startedAt));
  }, [running, startedAt]);
  if (startedAt === null) return 0;
  if (!running && frozen !== null) return frozen;
  return Math.max(0, now - startedAt);
}

/**
 * BTW's own status line. Visually matches the transcript's working line — same
 * rotating asterisk, same sweep on the verb, same elapsed format — but BTW runs
 * an ephemeral turn with tools disabled, so there is no tool/thinking
 * granularity to report: only its four states plus the clock.
 */
export function BtwStatusLine({
  snapshot,
  startedAt,
  compact,
}: {
  snapshot: BtwSnapshot | null;
  /** Epoch ms of the first `running` sighting; null before the first ask. */
  startedAt: number | null;
  /** Capsule variant: no glyph, tighter type. */
  compact?: boolean;
}) {
  const status: BtwStatus | "idle" = snapshot?.status ?? "idle";
  const running = status === "running";
  const elapsed = useFrozenElapsed(startedAt, running);
  const label = btwStatusLabel(snapshot);
  const showClock = startedAt !== null && status !== "idle";

  return (
    <div className={`btw-status${compact === true ? " compact" : ""}`} data-status={status}>
      {compact === true ? null : (
        <span className="btw-status-glyph" aria-hidden="true">
          <Icon name="asterisk" extra="sm" />
        </span>
      )}
      <span className="btw-status-text" role="status" aria-live="polite">
        <span className="btw-status-label">{label}</span>
        {showClock ? (
          <>
            <span className="btw-status-sep">·</span>
            <span className="btw-status-elapsed">{formatElapsed(elapsed)}</span>
          </>
        ) : null}
      </span>
    </div>
  );
}

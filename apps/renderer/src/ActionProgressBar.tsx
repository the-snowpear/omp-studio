export type ActionProgress = {
  readonly label: string;
  readonly step: number;
  readonly steps: number;
};

export function ActionProgressBar({
  label,
  step,
  steps,
  compact = false,
}: ActionProgress & { compact?: boolean }) {
  const total = Math.max(1, steps);
  const current = Math.min(total, Math.max(0, step));
  const pct = Math.round((current / total) * 100);
  return (
    <div
      className={`action-progress${compact ? " compact" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${label}（${current}/${total}）`}
    >
      <div className="action-progress-copy">
        <span>{label}</span>
        <span className="action-progress-count">{current}/{total}</span>
      </div>
      <div className="progress">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

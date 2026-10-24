import type { JobWidgetBlock, JobWidgetTone, JobWidgetTrend, JobWidgetView } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import "./jobs.css";

/**
 * React rendering of an upstream `JobWidgetView` (plain JSON from the Runtime).
 * Never uses the TUI renderer: every block kind is drawn from its data here.
 */

const TONE_COLOR: Record<JobWidgetTone, string> = {
  neutral: "var(--text-2)",
  accent: "var(--accent)",
  info: "var(--blue)",
  success: "var(--green)",
  warning: "var(--amber)",
  error: "var(--red)",
  pending: "var(--text-3)",
  muted: "var(--text-3)",
  user: "var(--purple)",
};

export function toneColor(tone: JobWidgetTone | undefined, fallback = "var(--accent)"): string {
  return tone === undefined ? fallback : (TONE_COLOR[tone] ?? fallback);
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function Trend({ trend }: { trend: JobWidgetTrend | undefined }) {
  if (!trend?.text) return null;
  return (
    <span className="jw-trend" style={{ color: toneColor(trend.tone, "var(--text-3)") }}>
      {trend.text}
    </span>
  );
}

const SPARK_W = 240;
const SPARK_H = 44;

function SparkBlock({ block, compact }: { block: Extract<JobWidgetBlock, { kind: "spark" }>; compact: boolean }) {
  const values = block.values.filter((value) => Number.isFinite(value)).slice(-48);
  const min = finite(block.min);
  const max = finite(block.max, min + 1);
  const span = max - min || 1;
  const height = compact ? 24 : SPARK_H;
  const y = (value: number) => height - clamp01((value - min) / span) * height;
  const step = values.length > 0 ? SPARK_W / values.length : SPARK_W;
  const color = toneColor(block.tone);
  return (
    <div className="jw-block jw-spark">
      <div className="jw-row">
        <span className="jw-label">{block.label}</span>
        <span className="jw-value" style={{ color }}>{block.last}</span>
      </div>
      <svg
        className="jw-spark-svg"
        viewBox={`0 0 ${SPARK_W} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${block.label}: ${block.last}`}
      >
        {values.map((value, index) => {
          const top = y(value);
          return (
            <rect
              key={index}
              data-testid="jw-spark-col"
              x={index * step + step * 0.12}
              y={top}
              width={Math.max(1, step * 0.76)}
              height={Math.max(1, height - top)}
              rx={1}
              fill={color}
              opacity={index === values.length - 1 ? 1 : 0.55}
            >
              <title>{block.tips?.[index] ?? String(value)}</title>
            </rect>
          );
        })}
        {(compact ? [] : (block.marks ?? [])).map((mark, index) => {
          const top = y(finite(mark.value));
          return (
            <g key={`m${index}`} className="jw-mark">
              <line
                x1={0}
                x2={SPARK_W}
                y1={top}
                y2={top}
                stroke={toneColor(mark.tone, "var(--text-3)")}
                strokeDasharray="4 3"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <title>{`${mark.label}: ${mark.value}`}</title>
            </g>
          );
        })}
      </svg>
      {!compact && block.marks?.length ? (
        <div className="jw-marks">
          {block.marks.map((mark, index) => (
            <span key={index} style={{ color: toneColor(mark.tone, "var(--text-3)") }}>
              ┄ {mark.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BarsBlock({ block, compact }: { block: Extract<JobWidgetBlock, { kind: "bars" }>; compact: boolean }) {
  const max = finite(block.max, 1) || 1;
  const items = compact ? block.items.slice(0, 3) : block.items;
  return (
    <div className="jw-block jw-bars">
      {block.label ? <div className="jw-label">{block.label}</div> : null}
      {items.map((item, index) => (
        <div key={index} className="jw-bar-row">
          <span className="jw-bar-label">{item.label}</span>
          <span className="jw-bar-track">
            <span
              className="jw-bar-fill"
              style={{ width: `${clamp01(finite(item.value) / max) * 100}%`, background: toneColor(item.tone) }}
            />
          </span>
          <span className="jw-bar-text">{item.text}</span>
        </div>
      ))}
      {compact && block.items.length > items.length ? (
        <div className="jw-more">+{block.items.length - items.length}</div>
      ) : null}
    </div>
  );
}

function MeterBlock({ block }: { block: Extract<JobWidgetBlock, { kind: "meter" }> }) {
  const value = clamp01(finite(block.value));
  return (
    <div className="jw-block jw-meter">
      <div className="jw-row">
        <span className="jw-label">{block.label}</span>
        <span className="jw-value">{block.text}</span>
      </div>
      <div
        className="jw-bar-track"
        role="progressbar"
        aria-label={block.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value * 100)}
      >
        <span className="jw-bar-fill" style={{ width: `${value * 100}%`, background: toneColor(block.tone) }} />
      </div>
    </div>
  );
}

function StatBlock({ block }: { block: Extract<JobWidgetBlock, { kind: "stat" }> }) {
  return (
    <div className="jw-block jw-stats">
      {block.items.map((item, index) => (
        <span key={index} className="jw-stat">
          <span className="jw-stat-label">{item.label}</span>
          <span className="jw-stat-text" style={{ color: toneColor(item.tone, "var(--text)") }}>
            {item.text}
          </span>
          <Trend trend={item.trend} />
        </span>
      ))}
    </div>
  );
}

function GridBlock({ block }: { block: Extract<JobWidgetBlock, { kind: "grid" }> }) {
  return (
    <div className="jw-block jw-grid-block">
      {block.label ? <div className="jw-label">{block.label}</div> : null}
      <div className="jw-grid">
        {block.items.map((item, index) => (
          <span
            key={index}
            className="jw-cell"
            title={`${item.label}: ${item.text}`}
            style={{ borderColor: toneColor(item.tone), color: toneColor(item.tone) }}
          >
            <span className="jw-cell-label">{item.label}</span>
            <span className="jw-cell-text">{item.text}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function JobWidgetBlockView({ block, compact = false }: { block: JobWidgetBlock; compact?: boolean }) {
  switch (block.kind) {
    case "spark":
      return <SparkBlock block={block} compact={compact} />;
    case "bars":
      return <BarsBlock block={block} compact={compact} />;
    case "meter":
      return <MeterBlock block={block} />;
    case "stat":
      return <StatBlock block={block} />;
    case "grid":
      return <GridBlock block={block} />;
    case "text":
      return <div className="jw-block jw-text">{block.text}</div>;
    default:
      return null;
  }
}

function ago(updatedAt: number, now: number, zh: boolean): string {
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
}

/**
 * Full widget: title, headline, stage, state and every block. `compact` keeps
 * only the primary (first) block, as tiles and the HUD do upstream.
 */
export function JobWidget({ view, compact = false, now = Date.now() }: { view: JobWidgetView; compact?: boolean; now?: number }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const blocks = compact ? view.blocks.slice(0, 1) : view.blocks;
  const stateLabel =
    view.state === "authoring" ? (zh ? "生成中" : "authoring") : view.state === "live" ? (zh ? "实时" : "live") : zh ? "基础" : "fallback";
  return (
    <div className={`job-widget${compact ? " compact" : ""}`} data-state={view.state}>
      {compact ? null : (
        <div className="jw-head">
          <span className="jw-title">{view.title}</span>
          <span className={`jw-state ${view.state}`}>{stateLabel}</span>
          {Number.isFinite(view.updatedAt) && view.updatedAt > 0 ? (
            <span className="jw-updated">{ago(view.updatedAt, now, zh)}</span>
          ) : null}
        </div>
      )}
      {view.headline ? (
        <div className="jw-headline">
          <span className="jw-headline-text">{view.headline.text}</span>
          {view.headline.label ? <span className="jw-headline-label">{view.headline.label}</span> : null}
          <Trend trend={view.headline.trend} />
        </div>
      ) : null}
      {blocks.map((block, index) => (
        <JobWidgetBlockView key={index} block={block} compact={compact} />
      ))}
      {view.stage && !compact ? <div className="jw-stage">{view.stage}</div> : null}
    </div>
  );
}

/** A task's own completion estimate (0–100) as a ring. */
export function CompletionRing({ percent, size = 22 }: { percent: number; size?: number }) {
  const value = Math.min(100, Math.max(0, Math.round(percent)));
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  return (
    <span className="jw-ring" title={`${value}%`} role="img" aria-label={`${value}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={2.5} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2.5}
          strokeDasharray={`${(c * value) / 100} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="jw-ring-text">{value}%</span>
    </span>
  );
}

export type JobTileData = {
  readonly id: string;
  readonly status: string;
  readonly label: string;
  readonly type?: string;
  readonly stage?: string;
  readonly completionPercent?: number;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly widget?: JobWidgetView;
};

const STATUS_CHIP: Record<string, string> = {
  running: "blue",
  queued: "gray",
  completed: "green",
  failed: "red",
  cancelled: "gray",
};

/** One job as the `wait` card shows it: status, label, stage, mini widget, completion and exit. */
export function JobTile({ job }: { job: JobTileData }) {
  const stage = job.stage ?? job.widget?.stage;
  return (
    <div className="job-tile" data-status={job.status}>
      <div className="jt-head">
        <span className={`chip xs ${STATUS_CHIP[job.status] ?? "gray"}`}>{job.status}</span>
        <span className="jt-label" title={job.label}>{job.widget?.title ?? job.label}</span>
        <span className="jt-id mono">{job.id}</span>
        {job.completionPercent !== undefined && job.status === "running" ? (
          <CompletionRing percent={job.completionPercent} />
        ) : null}
        {job.exitCode !== undefined ? (
          <span className={`chip xs ${job.exitCode === 0 ? "green" : "red"}`}>exit {job.exitCode}</span>
        ) : null}
      </div>
      {stage ? <div className="jt-stage">{stage}</div> : null}
      {job.widget && job.widget.blocks.length > 0 ? <JobWidget view={job.widget} compact /> : null}
    </div>
  );
}

import { useMemo, useRef } from "react";
import { motionReduced } from "../../motion";
import type { DeckGroup, DeckTotals } from "./deckModel";
import { formatClock, formatCost, formatTokens, formatTps } from "./deckModel";
import { useRolledNumber } from "./motionKit";
import type { SwarmSample } from "./swarmRecorder";
import type { AgentRosterSource } from "../AgentRosterMeter";

const GROUP_ORDER: readonly DeckGroup[] = ["failed", "waiting", "running", "settled"];
const SPARK_POINTS = 90;

function Rolled({ value, format, instant }: { value: number | undefined; format: (value: number) => string; instant: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const shown = useRolledNumber(value ?? 0, ref, "hero", instant);
  return <strong ref={ref}>{value === undefined ? "—" : format(instant ? value : shown)}</strong>;
}

/** The rate trace: one point a second, newest on the right, scaled to its own peak. */
function Spark({ samples, now }: { samples: readonly SwarmSample[]; now: number }) {
  const { line, area, last } = useMemo(() => {
    const recent = samples.filter(sample => sample.at <= now && sample.at >= now - (SPARK_POINTS - 1) * 1000);
    const peak = Math.max(1, ...recent.map(sample => sample.tps)) * 1.15;
    const points = recent.map(sample => [SPARK_POINTS - 1 - (now - sample.at) / 1000, 30 - (sample.tps / peak) * 26] as const);
    if (points.length === 0) return { line: "", area: "", last: undefined };
    const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
    const first = points[0]!, end = points[points.length - 1]!;
    return { line, area: `${line}L${end[0]} 31L${first[0]} 31Z`, last: end };
  }, [samples, now]);
  return <svg className="ad-spark" viewBox={`0 0 ${SPARK_POINTS - 1} 31`} preserveAspectRatio="none" aria-hidden="true">
    <path className="ad-spark-base" d={`M0 30.5H${SPARK_POINTS}`} />
    {area ? <path className="ad-spark-area" d={area} /> : null}
    {line ? <path className="ad-spark-line" d={line} /> : null}
    {last ? <circle className="ad-spark-head" cx={last[0]} cy={last[1]} r="1.6" /> : null}
  </svg>;
}

export function PulseHeader({ totals, samples, source, preview, marks, live = true, now, replayAt, groups, onGroup, d, compact }: {
  totals: DeckTotals;
  samples: readonly SwarmSample[];
  source: AgentRosterSource;
  preview: boolean;
  marks: boolean;
  live?: boolean | undefined;
  now: number;
  replayAt: number | null;
  groups: ReadonlySet<DeckGroup>;
  onGroup: (group: DeckGroup) => void;
  d: (key: string, params?: Record<string, string | number>) => string;
  compact: boolean;
}) {
  const shownSource = preview ? "live" : source;
  const elapsed = totals.startedAt === undefined ? undefined : formatClock((replayAt ?? now) - totals.startedAt);
  const total = Math.max(1, totals.children);
  const replaying = replayAt !== null;
  const instant = replaying || !live || motionReduced();
  const cut = replayAt ?? now;
  const replaySamples = samples.filter(sample => sample.at <= cut);
  const rate = replaying ? replaySamples.at(-1)?.tps ?? totals.tps : totals.tps;
  return <header className="ad-pulse" data-compact={compact || undefined}>
    <div className="ad-pulse-line">
      <span className="ad-live" data-source={shownSource} data-replay={replayAt !== null || undefined}>
        <i aria-hidden="true" />
        {replayAt !== null ? d("replay.at", { time: new Date(replayAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }) : d(`source.${shownSource}`)}
      </span>
      <span className="ad-pulse-count">{d("agentsCount", { count: totals.agents })}<span className="ad-pulse-sep" aria-hidden="true">·</span>{d("runningCount", { count: totals.groups.running })}</span>
      {preview && marks ? <span className="chip gray xs">{d("demo")}</span> : null}
      {elapsed ? <span className="ad-pulse-clock" data-tip={d("elapsedTip")}>{elapsed}</span> : null}
    </div>
    <div className="ad-ribbon" role="group" aria-label={d("ribbonLabel")}>
      {GROUP_ORDER.map(group => {
        const count = totals.groups[group];
        const label = d(`groups.${group}`);
        return <button key={group} type="button" className="ad-ribbon-seg" data-group={group} aria-pressed={groups.has(group)}
          style={{ flexGrow: count / total }} hidden={count === 0} data-tip={d("ribbonTip", { label, count })}
          aria-label={d("ribbonTip", { label, count })} onClick={() => onGroup(group)} />;
      })}
      {totals.children === 0 ? <span className="ad-ribbon-empty" aria-hidden="true" /> : null}
    </div>
    <dl className="ad-metrics" data-tip={totals.tokens === undefined || totals.cost === undefined || totals.tools === undefined ? d("replay.usageUnknown") : undefined}>
      <div><dt>{d("metrics.tokens")}</dt><dd><Rolled value={totals.tokens} format={formatTokens} instant={instant} /></dd></div>
      <div><dt>{d("metrics.cost")}</dt><dd><Rolled value={totals.cost} format={formatCost} instant={instant} /></dd></div>
      <div><dt>{d("metrics.tools")}</dt><dd><Rolled value={totals.tools} format={value => String(Math.round(value))} instant={instant} /></dd></div>
      <div className="ad-metric-rate" data-tip={d("rateTip")}>
        <dt>{d("metrics.rate")}</dt>
        <dd><Rolled value={rate} format={formatTps} instant={instant || rate === 0} /><small>{d("metrics.rateUnit")}</small></dd>
        <Spark samples={samples} now={cut} />
      </div>
    </dl>
  </header>;
}

import { useEffect, useMemo, useState } from "react";
import { Icon } from "../../icons";
import { subagentDurationMs } from "../../conversation/SubagentMetrics";
import { AgentSigil } from "./AgentSigil";
import type { DeckNotice } from "./deckActions";
import type { DeckAgent, DeckGroup, DeckTotals } from "./deckModel";
import { formatClock, formatCost, formatTokens, formatTps } from "./deckModel";
import type { Caps } from "../hub/types";
import { concurrency, tickLabel, type Lane } from "./timelineModel";

type D = (key: string, params?: Record<string, string | number>) => string;

export type InspectorActions = {
  readonly onOpen: (row: DeckAgent) => void;
  readonly onMain: () => void;
  readonly onHub: (row: DeckAgent) => void;
  readonly onBtw: ((row: DeckAgent) => void) | undefined;
  readonly canLocate: (row: DeckAgent) => boolean;
  readonly onLocate: (row: DeckAgent) => Promise<boolean>;
  readonly caps: (row: DeckAgent) => Caps;
  readonly run: (kind: "kill" | "revive", row: DeckAgent) => Promise<boolean>;
  readonly busy: string | null;
  readonly notice: DeckNotice | null;
};

export function AgentInspector({ row, rows, lane, now, actions, onSelect, onClose, d }: {
  row: DeckAgent;
  rows: readonly DeckAgent[];
  lane: Lane | undefined;
  now: number;
  actions: InspectorActions;
  onSelect: (id: string | null) => void;
  onClose?: (() => void) | undefined;
  d: D;
}) {
  const [confirming, setConfirming] = useState<DeckAgent | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [locateMissing, setLocateMissing] = useState(false);
  useEffect(() => { setConfirming(null); setTaskOpen(false); setLocateMissing(false); }, [row.id]);
  const parent = rows.find(item => item.id === row.parentId);
  const children = rows.filter(item => item.parentId === row.id);
  const duration = subagentDurationMs(row.agent, now);
  const caps = actions.caps(row);
  const identity = { id: row.id, name: row.name, hue: row.hue, main: row.main };
  const trail = useMemo(() => (lane?.marks ?? []).slice(-6).reverse(), [lane]);
  const notice = actions.notice?.agentId === row.id ? actions.notice : null;
  const context = row.context ? Math.min(1, row.context.used / row.context.window) : undefined;
  const tiles: [string, string][] = [
    [d("inspector.duration"), duration === undefined ? "—" : formatClock(duration)],
    [d("inspector.tokens"), row.tokens === undefined ? "—" : formatTokens(row.tokens)],
    [d("inspector.requests"), row.requests === undefined ? "—" : String(row.requests)],
    [d("inspector.tools"), row.tools === undefined ? "—" : String(row.tools)],
    [d("inspector.cost"), row.cost === undefined ? "—" : formatCost(row.cost)],
    [d("inspector.rate"), row.tps === undefined || row.tone !== "running" ? "—" : `${formatTps(row.tps)} t/s`],
  ];
  const facts = ([
    [d("inspector.branch"), row.agent.branchName],
    [d("inspector.output"), row.agent.outputPath],
    [d("inspector.patch"), row.agent.patchPath],
  ] as const).filter((fact): fact is readonly [string, string] => typeof fact[1] === "string" && fact[1] !== "");
  const canLocate = !row.main && actions.canLocate(row);
  const locate = async () => {
    setLocateMissing(false);
    if (!await actions.onLocate(row)) setLocateMissing(true);
  };

  return <div className="ad-inspector" key={row.id}>
    <header className="ad-ins-head">
      <AgentSigil identity={identity} tone={row.tone} size={44} progress={row.progress} ring />
      <div className="ad-ins-id">
        {parent ? <button type="button" className="ad-ins-crumb" onClick={() => onSelect(parent.id)}><Icon name="arrow-u" extra="xs" />{parent.name}</button> : null}
        <h3 title={row.name}>{row.name}</h3>
        <div className="ad-ins-sub">
          <span className="ad-status" data-tone={row.tone}><i aria-hidden="true" /><span>{row.statusText}</span></span>
          <span className="ad-ins-model" title={`${d("inspector.model")}: ${row.model ?? row.modelLabel}`}>
            {row.fallback ? <span className="ad-ins-fallback" data-tip={d("inspector.fallback")}><Icon name="undo" extra="xs" /></span> : null}
            {row.modelLabel}{row.role ? <em>{row.role}</em> : null}
          </span>
        </div>
      </div>
      {onClose ? <button type="button" className="icon-btn small ad-ins-close" aria-label={d("inspector.close")} data-tip={d("inspector.close")} onClick={onClose}><Icon name="x" extra="sm" /></button> : null}
    </header>

    <div className="ad-ins-actions">
      {confirming
        ? <div className="ad-confirm" role="alertdialog" aria-label={d("stop")}>
          <p>{d("stopConfirm", { name: confirming.name })}</p>
          <div>
            <button type="button" className="btn small danger solid" disabled={!caps.kill || actions.busy === row.id} data-tip={caps.killWhy ?? undefined}
              onClick={() => { void actions.run("kill", confirming).then(() => setConfirming(null)); }}>{d("stop")}</button>
            <button type="button" className="btn small" autoFocus onClick={() => setConfirming(null)}>{d("cancel")}</button>
          </div>
        </div>
        : <>
          <button type="button" className="btn small primary" onClick={() => row.main ? actions.onMain() : actions.onOpen(row)} disabled={!row.main && !caps.open}
            data-tip={!row.main && !caps.open ? caps.openWhy ?? undefined : undefined}>
            <Icon name={row.main ? "arrow-l" : "message"} extra="sm" />{row.main ? d("backToMain") : d("open")}
          </button>
          {canLocate ? <button type="button" className="btn small" onClick={() => { void locate(); }}><Icon name="search" extra="sm" />{d("locate")}</button> : null}
          {!row.main && actions.onBtw ? <button type="button" className="btn small" onClick={() => actions.onBtw?.(row)}><Icon name="sparkles" extra="sm" />{d("btw")}</button> : null}
          {!row.main ? <button type="button" className="btn small" onClick={() => actions.onHub(row)}><Icon name="external" extra="sm" />{d("hub")}</button> : null}
          {!row.main && row.agent.status === "parked"
            ? <button type="button" className="btn small" disabled={!caps.revive || actions.busy === row.id} data-tip={caps.reviveWhy ?? undefined}
              onClick={() => { void actions.run("revive", row); }}><Icon name="refresh" extra="sm" />{d("revive")}</button>
            : !row.main && row.tone !== "stopped" ? <button type="button" className="btn small danger" disabled={!caps.kill || actions.busy === row.id}
              data-tip={caps.killWhy ?? undefined} onClick={() => setConfirming(row)}><Icon name="stop" extra="sm" />{d("stop")}</button> : null}
        </>}
      {locateMissing ? <p className="ad-ins-note" role="status">{d("locateMissing")}</p> : null}
      {notice ? <p className="ad-ins-note" data-kind={notice.kind} role="status">{notice.detail || d(notice.key, notice.params)}</p> : null}
    </div>

    <section className="ad-ins-section">
      <h4>{d("inspector.stage")}</h4>
      <div className="ad-ins-now" data-running={row.tone === "running" || undefined}>
        <Icon name={row.tone === "failed" ? "alert" : row.tone === "waiting" ? "clock" : "pulse"} extra="sm" />
        <span>{row.stage ?? d("inspector.noStage")}</span>
      </div>
      {row.progress !== undefined || row.steps ? <div className="ad-ins-progress">
        <span className="ad-ins-bar"><i style={{ inlineSize: `${((row.progress ?? 0) * 100).toFixed(1)}%` }} /></span>
        <span className="ad-ins-pct">{row.steps ? d("inspector.steps", { done: row.steps.completed, total: row.steps.total }) : `${Math.round((row.progress ?? 0) * 100)}%`}</span>
      </div> : null}
      {trail.length ? <ol className="ad-ins-trail" aria-label={d("inspector.trail")}>
        {trail.map(mark => <li key={mark.at}><time>{tickLabel(mark.at, 0)}</time><span>{mark.text}</span></li>)}
      </ol> : null}
    </section>

    {row.task ? <section className="ad-ins-section">
      <h4>{d("inspector.task")}</h4>
      <p className="ad-ins-task" data-clamped={!taskOpen && row.task.length > 220 || undefined}>{row.task}</p>
      {row.task.length > 220 ? <button type="button" className="ad-link" onClick={() => setTaskOpen(value => !value)}>{taskOpen ? d("inspector.less") : d("inspector.more")}</button> : null}
    </section> : null}

    <section className="ad-ins-section">
      <h4>{d("inspector.usage")}</h4>
      <dl className="ad-ins-tiles">{tiles.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {context !== undefined ? <div className="ad-ins-context" data-high={context > 0.8 || undefined}>
        <span>{d("inspector.context")}</span>
        <span className="ad-ins-bar"><i style={{ inlineSize: `${(context * 100).toFixed(1)}%` }} /></span>
        <span>{formatTokens(row.context!.used)} / {formatTokens(row.context!.window)}</span>
      </div> : null}
    </section>

    {facts.length || row.agent.isolated ? <section className="ad-ins-section">
      <h4>{d("inspector.facts")}</h4>
      <dl className="ad-ins-facts">
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code title={value}>{value}</code></dd></div>)}
        {row.agent.isolated ? <div><dt>{d("inspector.isolated")}</dt><dd><Icon name="shield" extra="xs" /></dd></div> : null}
      </dl>
    </section> : null}

    {children.length ? <section className="ad-ins-section">
      <h4>{d("inspector.children")}<span>{children.length}</span></h4>
      <div className="ad-ins-children">
        {children.map(child => <button key={child.id} type="button" className="ad-chip-agent" onClick={() => onSelect(child.id)}>
          <AgentSigil identity={{ id: child.id, name: child.name, hue: child.hue, main: child.main }} tone={child.tone} size={16} />
          <span>{child.name}</span><i className="ad-dot" data-tone={child.tone} aria-hidden="true" />
        </button>)}
      </div>
    </section> : null}
  </div>;
}

const GROUP_ORDER: readonly DeckGroup[] = ["running", "waiting", "failed", "settled"];

/** The bridge's right column when nothing is selected: the swarm at a glance. */
export function SwarmSummary({ rows, totals, lanes, range, now, onSelect, d }: {
  rows: readonly DeckAgent[]; totals: DeckTotals; lanes: readonly Lane[]; range: { start: number; end: number }; now: number;
  onSelect: (id: string) => void; d: D;
}) {
  const byModel = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) if (row.tokens) map.set(row.modelLabel, (map.get(row.modelLabel) ?? 0) + row.tokens);
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [rows]);
  const top = useMemo(() => rows.filter(row => !row.main && row.tokens).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 3), [rows]);
  const peak = useMemo(() => Math.max(0, ...concurrency(lanes, range.start, range.end, now, 120)), [lanes, range, now]);
  const children = Math.max(1, totals.children);
  const maxModel = Math.max(1, ...byModel.map(([, value]) => value));
  let offset = 0;
  return <div className="ad-summary">
    <header><h3>{d("summary.title")}</h3><p>{d("summary.hint")}</p></header>
    <div className="ad-summary-donut">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle className="ad-donut-track" cx="32" cy="32" r="26" />
        {GROUP_ORDER.map(group => {
          const share = totals.groups[group] / children;
          const element = share > 0 ? <circle key={group} className="ad-donut-seg" data-group={group} cx="32" cy="32" r="26" pathLength={100}
            strokeDasharray={`${Math.max(0, share * 100 - 1.5).toFixed(2)} 100`} strokeDashoffset={(-offset * 100).toFixed(2)} /> : null;
          offset += share;
          return element;
        })}
      </svg>
      <div className="ad-donut-center"><strong>{totals.children}</strong><span>{d("summary.children")}</span></div>
      <ul>{GROUP_ORDER.map(group => <li key={group} data-group={group}><i aria-hidden="true" />{d(`groups.${group}`)}<span>{totals.groups[group]}</span></li>)}</ul>
    </div>
    <dl className="ad-ins-tiles is-summary">
      <div><dt>{d("metrics.tokens")}</dt><dd>{totals.tokens === undefined ? "—" : formatTokens(totals.tokens)}</dd></div>
      <div><dt>{d("metrics.cost")}</dt><dd>{totals.cost === undefined ? "—" : formatCost(totals.cost)}</dd></div>
      <div><dt>{d("summary.peak")}</dt><dd>{peak}</dd></div>
    </dl>
    {byModel.length ? <section className="ad-ins-section">
      <h4>{d("summary.byModel")}</h4>
      <ul className="ad-bars">{byModel.map(([model, tokens]) => <li key={model}>
        <span className="ad-bars-label" title={model}>{model}</span>
        <span className="ad-bars-track"><i style={{ inlineSize: `${(tokens / maxModel * 100).toFixed(1)}%` }} /></span>
        <span className="ad-bars-value">{formatTokens(tokens)}</span>
      </li>)}</ul>
    </section> : null}
    {top.length ? <section className="ad-ins-section">
      <h4>{d("summary.top")}</h4>
      <div className="ad-ins-children is-list">{top.map(row => <button key={row.id} type="button" className="ad-chip-agent" onClick={() => onSelect(row.id)}>
        <AgentSigil identity={{ id: row.id, name: row.name, hue: row.hue, main: row.main }} tone={row.tone} size={16} />
        <span>{row.name}</span><em>{formatTokens(row.tokens ?? 0)}</em>
      </button>)}</div>
    </section> : null}
  </div>;
}

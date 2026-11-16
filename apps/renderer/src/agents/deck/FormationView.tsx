import { useMemo, useRef, type KeyboardEvent } from "react";
import { Icon } from "../../icons";
import { subagentDurationMs } from "../../conversation/SubagentMetrics";
import type { AgentRosterDensity } from "../../settings/appSettings";
import { AgentSigil } from "./AgentSigil";
import type { DeckAgent, DeckGroup } from "./deckModel";
import { formatClock, formatTokens } from "./deckModel";
import { useFlip } from "./motionKit";

/** One generation's indent, and where a sigil's centre sits from its card's left edge. */
const INDENT = 26;
const STEM = 20;
const STATUS_ORDER: readonly DeckGroup[] = ["running", "waiting", "failed", "settled"];

type Line = { row: DeckAgent; depth: number; guides: readonly boolean[]; last: boolean; hiddenChildren: number; stem: boolean };

/** Parent-first lines with the guide columns a tree needs: which ancestors still have siblings below. */
function treeLines(rows: readonly DeckAgent[], visible: ReadonlySet<string>, collapsed: ReadonlySet<string>): Line[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  const lines: Line[] = [];
  const visit = (row: DeckAgent, depth: number, guides: boolean[], last: boolean) => {
    const kids = row.childIds.map(id => byId.get(id)).filter((child): child is DeckAgent => child !== undefined && visible.has(child.id));
    const folded = collapsed.has(row.id);
    lines.push({ row, depth, guides, last, hiddenChildren: folded ? kids.length : 0, stem: kids.length > 0 && !folded });
    if (folded) return;
    kids.forEach((child, index) => visit(child, depth + 1, depth === 0 ? [] : [...guides, !last], index === kids.length - 1));
  };
  const roots = rows.filter(row => visible.has(row.id) && (row.parentId === undefined || !byId.has(row.parentId)));
  roots.forEach((root, index) => visit(root, 0, [], index === roots.length - 1));
  return lines;
}

export function FormationView({ rows, visible, matched, selectedId, openedIds, grouping, collapsed, filtering, density, compact = false, now, query, onSelect, onOpen, onToggle, d }: {
  /** A low panel: every row, the lead's included, is a single line. */
  compact?: boolean;
  rows: readonly DeckAgent[];
  visible: ReadonlySet<string>;
  matched: ReadonlySet<string>;
  selectedId: string | null;
  openedIds: readonly string[];
  grouping: "tree" | "status";
  collapsed: ReadonlySet<string>;
  filtering: boolean;
  density: AgentRosterDensity;
  now: number;
  query: string;
  onSelect: (id: string) => void;
  onOpen: (row: DeckAgent) => void;
  onToggle: (id: string) => void;
  d: (key: string, params?: Record<string, string | number>) => string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const folds = useMemo(() => filtering ? new Set<string>() : collapsed, [filtering, collapsed]);
  const sections = useMemo(() => {
    if (grouping === "tree") return [{ group: null, lines: treeLines(rows, visible, folds) }];
    return STATUS_ORDER.map(group => ({
      group,
      lines: rows.filter(row => !row.main && row.group === group && matched.has(row.id)).map(row => ({ row, depth: 0, guides: [], last: true, hiddenChildren: 0, stem: false })),
    })).filter(section => section.lines.length > 0);
  }, [grouping, rows, visible, matched, folds]);
  const signature = `${grouping}|${sections.map(section => `${section.group}:${section.lines.map(line => line.row.id).join(",")}`).join("|")}`;
  useFlip(listRef, signature);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const hits = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(".ad-card-hit") ?? [])];
    if (hits.length === 0) return;
    const index = hits.indexOf(event.target as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? hits.length - 1 : Math.max(0, Math.min(hits.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    hits[next]?.focus();
  };

  if (sections.every(section => section.lines.length === 0)) {
    return <div className="ad-empty is-inline"><Icon name="search" /><p>{d("noMatch")}</p></div>;
  }
  return <div className="ad-formation" ref={listRef} onKeyDown={onKeyDown} data-density={density} role="list" aria-label={d("views.formation")}>
    {sections.map(section => <div className="ad-formation-section" key={section.group ?? "tree"} role="presentation">
      {section.group ? <div className="ad-section-head" data-group={section.group} role="presentation"><i aria-hidden="true" />{d(`groups.${section.group}`)}<span>{section.lines.length}</span></div> : null}
      {section.lines.map(line => <MemberCard key={line.row.id} line={line} now={now} density={density} compact={compact} query={query}
        selected={selectedId === line.row.id} opened={openedIds.includes(line.row.id)} dimmed={!matched.has(line.row.id)}
        collapsed={folds.has(line.row.id)} filtering={filtering} parentName={grouping === "status" ? rows.find(row => row.id === line.row.parentId && !row.main)?.name : undefined}
        onSelect={onSelect} onOpen={onOpen} onToggle={onToggle} d={d} />)}
    </div>)}
  </div>;
}

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  const index = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + needle.length)}</mark>{text.slice(index + needle.length)}</>;
}

function MemberCard({ line, now, density, compact, query, selected, opened, dimmed, collapsed, filtering, parentName, onSelect, onOpen, onToggle, d }: {
  line: Line; now: number; density: AgentRosterDensity; compact: boolean; query: string; selected: boolean; opened: boolean; dimmed: boolean; collapsed: boolean; parentName: string | undefined;
  filtering: boolean;
  onSelect: (id: string) => void; onOpen: (row: DeckAgent) => void; onToggle: (id: string) => void;
  d: (key: string, params?: Record<string, string | number>) => string;
}) {
  const { row, depth, guides, last } = line;
  const duration = subagentDurationMs(row.agent, now);
  const clock = duration === undefined ? undefined : formatClock(duration);
  const minimal = compact || (density === "minimal" && !row.main);
  const hasChildren = row.childIds.length > 0;
  const label = `${row.main ? d("backToMain") : d("open")} · ${row.name} · ${row.statusText}`;
  const identity = { id: row.id, name: row.name, hue: row.hue, main: row.main };
  return <div className="ad-node" role="listitem" data-flip={row.id} style={{ ["--depth" as string]: depth, paddingLeft: depth * INDENT }}>
    {guides.map((on, level) => on ? <span key={level} className="ad-guide" style={{ left: level * INDENT + STEM }} aria-hidden="true" /> : null)}
    {depth > 0 ? <span className={`ad-elbow${last ? " is-last" : ""}`} style={{ left: (depth - 1) * INDENT + STEM }} aria-hidden="true" /> : null}
    {line.stem ? <span className="ad-stem" style={{ left: depth * INDENT + STEM }} aria-hidden="true" /> : null}
    <div className={`ad-card${row.main ? " is-main" : ""}${minimal ? " is-minimal" : ""}`} data-tone={row.tone} data-selected={selected || undefined} data-dimmed={dimmed || undefined}>
      <button type="button" className="ad-card-hit" aria-pressed={selected} aria-label={label} title={row.task ?? row.name}
        onClick={() => onSelect(row.id)} onDoubleClick={() => onOpen(row)}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onOpen(row); } }} />
      <div className="ad-card-top">
        <span className="ad-card-sigil">
          <AgentSigil identity={identity} tone={row.tone} size={minimal ? 20 : row.main ? 32 : 28} progress={row.progress} ring={!minimal} />
          {opened ? <span className="ad-opened" data-tip={d("openedTip")} aria-hidden="true" /> : null}
        </span>
        <span className="ad-card-id">
          <span className="ad-card-name"><strong><Highlight text={row.name} query={query} /></strong>
            {row.main ? <span className="ad-lead">{d("commander")}</span> : null}
            {row.unread > 0 ? <span className="ad-unread" data-tip={d("inspector.unread", { count: row.unread })}><Icon name="message" extra="xs" />{row.unread}</span> : null}
          </span>
          {minimal ? null : <span className="ad-card-model">{row.fallback ? <Icon name="undo" extra="xs" /> : null}<span><Highlight text={row.modelLabel} query={query} /></span>{row.role ? <span className="ad-card-role">{row.role}</span> : null}</span>}
        </span>
        {minimal ? <span className="ad-card-model is-inline"><span>{row.modelLabel}</span></span> : null}
        <span className="ad-card-side">
          <span className="ad-status" data-tone={row.tone} title={row.statusText}><i aria-hidden="true" /><span>{row.statusText}</span></span>
          {clock && !minimal ? <span className="ad-card-clock">{clock}</span> : null}
        </span>
        {hasChildren && !minimal && !filtering ? <button type="button" className="ad-fold" aria-expanded={!collapsed}
          aria-label={collapsed ? d("expand") : d("collapse")} data-tip={collapsed ? d("childCount", { count: line.hiddenChildren }) : d("collapse")}
          onClick={() => onToggle(row.id)}><Icon name="chevron-d" extra="sm" /></button> : null}
        <button type="button" className="ad-quick" aria-label={row.main ? d("backToMain") : d("open")} data-tip={row.main ? d("backToMain") : d("open")}
          onClick={() => onOpen(row)}><Icon name={row.main ? "arrow-l" : "external"} extra="sm" /></button>
      </div>
      {minimal ? null : <>
        {parentName ? <div className="ad-card-parent"><Icon name="chevron-r" extra="xs" />{parentName}</div> : null}
        {row.task ? <p className="ad-card-task"><Highlight text={row.task} query={query} /></p> : null}
        {row.stage ? <div className="ad-card-stage" data-running={row.tone === "running" || undefined}>
          <Icon name={row.tone === "failed" ? "alert" : row.tone === "waiting" ? "clock" : "pulse"} extra="xs" />
          <span><Highlight text={row.stage} query={query} /></span>
        </div> : null}
        <CardMeter row={row} d={d} />
      </>}
    </div>
  </div>;
}

function CardMeter({ row, d }: { row: DeckAgent; d: (key: string, params?: Record<string, string | number>) => string }) {
  const facts: string[] = [];
  if (row.tokens !== undefined) facts.push(`${formatTokens(row.tokens)} tok`);
  if (row.tools !== undefined) facts.push(`${row.tools} ${d("toolsShort")}`);
  if (facts.length === 0 && !row.steps && !row.context) return null;
  const context = row.context ? Math.min(1, row.context.used / row.context.window) : undefined;
  return <div className="ad-card-meter">
    {row.steps ? <span className="ad-steps" aria-label={d("inspector.steps", { done: row.steps.completed, total: row.steps.total })}>
      {Array.from({ length: row.steps.total }, (_, index) => <i key={index} data-state={index < row.steps!.completed ? "done" : index < row.steps!.sent ? "sent" : "todo"} />)}
    </span> : null}
    {facts.length ? <span className="ad-card-facts">{facts.join(" · ")}</span> : null}
    {context !== undefined ? <span className="ad-ctx" data-tip={`${d("inspector.context")} ${Math.round(context * 100)}%`} data-high={context > 0.8 || undefined}>
      <i style={{ inlineSize: `${(context * 100).toFixed(1)}%` }} />
    </span> : null}
  </div>;
}

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../../icons";
import { AgentSigil, sigilStyle } from "./AgentSigil";
import type { DeckAgent, DeckTone } from "./deckModel";
import { formatClock } from "./deckModel";
import type { DeckUi } from "./deckState";
import { useWheel } from "./motionKit";
import { concurrency, laneToneAt, stageAt, tickLabel, timeTicks, type Lane } from "./timelineModel";

const ROW = 30;
const AXIS = 26;
const BAND = 34;
const BAR = 10;
const NOW_TAIL = 28;

function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const Observer = element.ownerDocument.defaultView?.ResizeObserver;
    setWidth(element.clientWidth);
    if (!Observer) return;
    const observer = new Observer(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function Cap({ tone, x, y }: { tone: DeckTone; x: number; y: number }) {
  const t = `translate(${x.toFixed(1)} ${y.toFixed(1)})`;
  if (tone === "idle") return <path className="ad-tl-cap" data-tone={tone} transform={t} d="M-3 0.2 -1 2.2 3 -2" />;
  if (tone === "failed") return <path className="ad-tl-cap" data-tone={tone} transform={t} d="M-2.5 -2.5 2.5 2.5M2.5 -2.5 -2.5 2.5" />;
  if (tone === "parked") return <path className="ad-tl-cap" data-tone={tone} transform={t} d="M1.6 -2.8A3 3 0 1 0 2.8 1.8 2.4 2.4 0 0 1 1.6 -2.8Z" />;
  if (tone === "stopped") return <rect className="ad-tl-cap is-solid" data-tone={tone} x={x - 2.5} y={y - 2.5} width={5} height={5} rx={1} />;
  return null;
}

export function TimelineView({ lanes, range, now, replay, ui, onTimeline, selectedId, matched, onSelect, onOpen, onScrub, labelWidth, d }: {
  lanes: readonly Lane[];
  range: { start: number; end: number };
  now: number;
  replay: number | null;
  ui: DeckUi["timeline"];
  onTimeline: (patch: Partial<DeckUi["timeline"]>) => void;
  selectedId: string | null;
  matched: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (row: DeckAgent) => void;
  onScrub: (at: number | null) => void;
  labelWidth: number;
  d: (key: string, params?: Record<string, string | number>) => string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const width = useWidth(plotRef);
  const [hover, setHover] = useState<string | null>(null);
  const full = Math.max(60_000, range.end - range.start);
  // Room to the right of "now" for its tag, so following the present never clips it.
  const tail = width > 120 ? NOW_TAIL / (width - NOW_TAIL) : 0.04;
  const span = Math.max(15_000, Math.min(full * 4, ui.span ?? full * (1 + tail)));
  const viewEnd = ui.follow || ui.end === null ? (ui.span === null ? range.end + full * tail : now + span * NOW_TAIL / Math.max(1, width)) : ui.end;
  const viewStart = viewEnd - span;
  const x = (at: number) => (at - viewStart) / span * width;
  const height = AXIS + lanes.length * ROW + BAND;
  const ticks = useMemo(() => timeTicks(viewStart, viewEnd, width, width < 360 ? 64 : 96), [viewStart, viewEnd, width]);
  const rowIndex = useMemo(() => new Map(lanes.map((lane, index) => [lane.row.id, index])), [lanes]);
  const curve = useMemo(() => {
    if (width <= 0) return "";
    const buckets = Math.max(8, Math.floor(width / 5));
    const counts = concurrency(lanes, viewStart, viewEnd, replay ?? now, buckets);
    const peak = Math.max(1, ...counts);
    const top = AXIS + lanes.length * ROW + 6, base = height - 4;
    const step = width / buckets;
    const points = counts.map((count, index) => `${index ? "L" : "M"}${(index * step + step / 2).toFixed(1)} ${(base - count / peak * (base - top)).toFixed(1)}`).join("");
    return `${points}L${width.toFixed(1)} ${base}L0 ${base}Z`;
  }, [lanes, viewStart, viewEnd, replay, now, width, height]);
  const cut = replay ?? now;
  const drag = useRef<{ x: number; end: number; moved: boolean } | null>(null);

  const zoom = (factor: number, anchorX?: number) => {
    const nextSpan = Math.max(15_000, Math.min(full * 4, span * factor));
    if (ui.follow) { onTimeline({ span: nextSpan }); return; }
    const anchor = anchorX === undefined ? viewEnd - span / 2 : viewStart + anchorX / Math.max(1, width) * span;
    onTimeline({ span: nextSpan, end: anchor + (viewEnd - anchor) * nextSpan / span });
  };
  useWheel(plotRef, event => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const rect = plotRef.current!.getBoundingClientRect();
      zoom(event.deltaY > 0 ? 1.18 : 1 / 1.18, event.clientX - rect.left);
      return;
    }
    const delta = event.shiftKey ? event.deltaY : event.deltaX;
    if (Math.abs(delta) < 1) return;
    event.preventDefault();
    onTimeline({ follow: false, span, end: viewEnd + delta / Math.max(1, width) * span });
  });
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-lane]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientY - rect.top < AXIS) {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: -1, end: viewEnd, moved: true };
      onScrub(Math.min(range.end, viewStart + (event.clientX - rect.left) / Math.max(1, width) * span));
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, end: viewEnd, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (state.x < 0) {
      const at = viewStart + (event.clientX - rect.left) / Math.max(1, width) * span;
      onScrub(at >= range.end ? null : Math.max(range.start, at));
      return;
    }
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < 4) return;
    state.moved = true;
    onTimeline({ follow: false, span, end: state.end - dx / Math.max(1, width) * span });
  };
  const onPointerUp = () => { drag.current = null; };

  const live = ui.follow && ui.end === null;
  return <div className="ad-tl" style={{ ["--tl-label" as string]: `${labelWidth}px` }}>
    <div className="ad-tl-tools">
      <span className="ad-tl-hint">{d("timeline.hint")}</span>
      <button type="button" className="icon-btn small" aria-label={d("timeline.zoomOut")} data-tip={d("timeline.zoomOut")} onClick={() => zoom(1.4)}><Icon name="minimize" extra="sm" /></button>
      <button type="button" className="icon-btn small" aria-label={d("timeline.zoomIn")} data-tip={d("timeline.zoomIn")} onClick={() => zoom(1 / 1.4)}><Icon name="plus" extra="sm" /></button>
      <button type="button" className="btn small" onClick={() => onTimeline({ follow: true, span: null, end: null })}><Icon name="expand" extra="sm" />{d("timeline.fit")}</button>
      {live ? null : <button type="button" className="btn small ad-back-live" onClick={() => onTimeline({ follow: true, end: null })}><Icon name="arrow-r" extra="sm" />{d("timeline.follow")}</button>}
    </div>
    <div className="ad-tl-scroll">
      <div className="ad-tl-body" style={{ height }}>
        <div className="ad-tl-labels">
          <div className="ad-tl-label-head" style={{ height: AXIS }} />
          {lanes.map(lane => {
            const row = lane.row;
            const tone = replay === null ? row.tone : laneToneAt(lane, replay) ?? row.tone;
            return <button key={row.id} type="button" className="ad-tl-label" data-selected={selectedId === row.id || undefined}
              data-hover={hover === row.id || undefined} data-dimmed={!matched.has(row.id) || undefined}
              style={{ height: ROW, paddingLeft: 8 + Math.min(row.depth, 4) * 10 }}
              onPointerEnter={() => setHover(row.id)} onPointerLeave={() => setHover(null)}
              onClick={() => onSelect(row.id)} onDoubleClick={() => onOpen(row)} aria-pressed={selectedId === row.id}>
              <AgentSigil identity={{ id: row.id, name: row.name, hue: row.hue, main: row.main }} tone={tone} size={16} />
              <span>{row.name}</span>
            </button>;
          })}
          <div className="ad-tl-band-label" style={{ height: BAND }}>{d("timeline.concurrency")}</div>
        </div>
        <div className="ad-tl-plot" ref={plotRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          {width > 0 ? <svg width={width} height={height} className="ad-tl-svg" role="img" aria-label={d("views.timeline")}>
            <g className="ad-tl-grid">
              {ticks.map(tick => <line key={tick} x1={x(tick)} x2={x(tick)} y1={AXIS - 4} y2={height} />)}
            </g>
            <g className="ad-tl-axis">
              <rect x={0} y={0} width={width} height={AXIS} className="ad-tl-axis-bg" />
              {ticks.map(tick => <text key={tick} x={x(tick) + 4} y={AXIS - 9}>{tickLabel(tick, span)}</text>)}
            </g>
            {lanes.map((lane, index) => {
              const y = AXIS + index * ROW;
              return <rect key={lane.row.id} className="ad-tl-row" x={0} y={y} width={width} height={ROW}
                data-selected={selectedId === lane.row.id || undefined} data-hover={hover === lane.row.id || undefined} />;
            })}
            <g className="ad-tl-links">
              {lanes.map(lane => {
                const parent = lane.row.parentId === undefined ? undefined : rowIndex.get(lane.row.parentId);
                const index = rowIndex.get(lane.row.id)!;
                if (parent === undefined || lane.start > cut) return null;
                const lx = x(lane.start);
                const py = AXIS + parent * ROW + ROW / 2, cy = AXIS + index * ROW + ROW / 2;
                return <g key={lane.row.id}>
                  <path d={`M${lx.toFixed(1)} ${(py + BAR / 2).toFixed(1)}V${(cy - BAR / 2).toFixed(1)}`} />
                  <circle cx={lx} cy={py} r={2.25} />
                </g>;
              })}
            </g>
            {lanes.map((lane, index) => {
              const row = lane.row;
              if (lane.start > cut) return null;
              const end = Math.min(lane.end ?? cut, cut);
              const open = lane.end === undefined || lane.end > cut;
              const x1 = x(lane.start), x2 = Math.max(x1 + 3, x(end));
              const cy = AXIS + index * ROW + ROW / 2;
              const tone = replay === null ? row.tone : laneToneAt(lane, replay) ?? row.tone;
              return <g key={row.id} className="ad-tl-lane" data-lane={row.id} data-tone={tone} data-open={open || undefined}
                data-dimmed={!matched.has(row.id) || undefined} data-main={row.main || undefined}
                style={sigilStyle({ id: row.id, name: row.name, hue: row.hue, main: row.main })}
                onPointerEnter={() => setHover(row.id)} onPointerLeave={() => setHover(null)}
                onClick={() => onSelect(row.id)} onDoubleClick={() => onOpen(row)}>
                <title>{`${row.name} · ${row.statusText}\n${d("timeline.started", { time: tickLabel(lane.start, 0) })}${lane.end !== undefined ? `\n${d("timeline.ended", { time: tickLabel(lane.end, 0) })}` : ""} · ${formatClock(end - lane.start)}${stageAt(lane, end) ? `\n${stageAt(lane, end)}` : ""}`}</title>
                <rect className="ad-tl-hit" x={x1 - 4} y={cy - ROW / 2 + 2} width={x2 - x1 + 8} height={ROW - 4} />
                <rect className="ad-tl-bar" x={x1} y={cy - BAR / 2} width={x2 - x1} height={BAR} rx={BAR / 2} />
                {open && replay === null && tone === "running" ? <rect className="ad-tl-sweep" x={x1} y={cy - BAR / 2} width={x2 - x1} height={BAR} rx={BAR / 2} /> : null}
                {lane.marks.filter(mark => mark.at <= end).map(mark => <circle key={mark.at} className="ad-tl-mark" cx={x(mark.at)} cy={cy} r={2}><title>{`${tickLabel(mark.at, 0)} · ${mark.text}`}</title></circle>)}
                {open ? <g className="ad-tl-head" transform={`translate(${x2.toFixed(1)} ${cy})`}>
                  {tone === "running" && replay === null ? <circle className="ad-tl-ripple" r={5} /> : null}
                  <circle r={3.5} />
                </g> : <Cap tone={tone} x={x2 + 8} y={cy} />}
              </g>;
            })}
            {curve ? <path className="ad-tl-curve" d={curve} /> : null}
            <line className="ad-tl-band-rule" x1={0} x2={width} y1={AXIS + lanes.length * ROW + 0.5} y2={AXIS + lanes.length * ROW + 0.5} />
            {now >= viewStart && now <= viewEnd ? <g className="ad-tl-now" transform={`translate(${x(now).toFixed(1)} 0)`}>
              <line y1={AXIS - 2} y2={height} />
              <rect x={-15} y={4} width={30} height={14} rx={7} />
              <text y={14.5} textAnchor="middle">{d("timeline.now")}</text>
            </g> : null}
            {replay !== null && replay >= viewStart && replay <= viewEnd ? <g className="ad-tl-playhead" transform={`translate(${x(replay).toFixed(1)} 0)`}>
              <line y1={0} y2={height} />
              <path d="M-5 0H5L0 6Z" />
            </g> : null}
          </svg> : null}
        </div>
      </div>
    </div>
  </div>;
}

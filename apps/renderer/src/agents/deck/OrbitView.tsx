import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../../icons";
import { MOTION_MS } from "../../motion";
import { SigilArt, sigilStyle } from "./AgentSigil";
import type { SwarmComms } from "./comms";
import type { DeckAgent, DeckTone } from "./deckModel";
import { formatTokens } from "./deckModel";
import type { DeckUi } from "./deckState";
import { useFrameLoop, useTweenedPoints, useWheel, type Point } from "./motionKit";
import { orbitChordPath, orbitEdgePath, orbitLayout } from "./orbitLayout";
import { laneToneAt, type Lane } from "./timelineModel";

const PACKET_MS = MOTION_MS.hero * 2;

function useSize(ref: { current: HTMLElement | null }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => setSize(current => current.width === element.clientWidth && current.height === element.clientHeight ? current : { width: element.clientWidth, height: element.clientHeight });
    read();
    const Observer = element.ownerDocument.defaultView?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function quadPoint(x1: number, y1: number, qx: number, qy: number, x2: number, y2: number, t: number): Point {
  const u = 1 - t;
  return { x: u * u * x1 + 2 * u * t * qx + t * t * x2, y: u * u * y1 + 2 * u * t * qy + t * t * y2 };
}

export function OrbitView({ rows, lanes, replay, comms, selectedId, matched, ui, onOrbit, onSelect, onOpen, d }: {
  rows: readonly DeckAgent[];
  lanes: readonly Lane[];
  replay: number | null;
  comms: SwarmComms;
  selectedId: string | null;
  matched: ReadonlySet<string>;
  ui: DeckUi["orbit"];
  onOrbit: (patch: Partial<DeckUi["orbit"]>) => void;
  onSelect: (id: string) => void;
  onOpen: (row: DeckAgent) => void;
  d: (key: string, params?: Record<string, string | number>) => string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { width, height } = useSize(boxRef);
  const [hover, setHover] = useState<string | null>(null);
  const treeKey = rows.map(row => `${row.id}>${row.parentId ?? ""}`).join("|");
  // Positions follow the tree only; status and usage updates never move a node.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => orbitLayout(rows), [treeKey]);
  const byId = useMemo(() => new Map(rows.map(row => [row.id, row])), [rows]);
  const laneById = useMemo(() => new Map(lanes.map(lane => [lane.row.id, lane])), [lanes]);
  const shownIds = useMemo(() => rows.filter(row => replay === null || (laneById.get(row.id)?.start ?? 0) <= replay).map(row => row.id), [rows, replay, laneById]);

  // Orbits are ellipses that use the panel's shape, but never so flat or tall that they stop reading as orbits.
  const cx = width / 2, cy = height / 2 - 8;
  const rings = layout.rings + (layout.virtualRoot ? 0.15 : 0.08);
  const reachX = Math.max(40, width / 2 - 56), reachY = Math.max(40, height / 2 - 52);
  const gapX = layout.rings === 0 ? 0 : Math.min(170, reachX / rings, (reachY / rings) * 1.5);
  const gapY = layout.rings === 0 ? 0 : Math.min(170, reachY / rings, gapX * 1.5);
  const gap = Math.min(gapX, gapY);
  const targets = useMemo(() => {
    const map = new Map<string, Point>();
    if (width <= 0) return map;
    for (const id of shownIds) {
      const node = layout.nodes.get(id);
      if (node) map.set(id, { x: cx + node.x * gapX, y: cy + node.y * gapY });
    }
    return map;
  }, [shownIds, layout, cx, cy, gapX, gapY, width]);
  const shownRef = useRef<ReadonlyMap<string, Point>>(new Map());
  const points = useTweenedPoints(targets, id => {
    const parent = byId.get(id)?.parentId;
    return parent === undefined ? undefined : shownRef.current.get(parent) ?? targets.get(parent);
  }, boxRef, "hero", "emphasis", `${treeKey}#${shownIds.join(",")}`);
  shownRef.current = points;

  const lit = useMemo(() => {
    if (hover === null) return null;
    const set = new Set<string>([hover]);
    for (let row = byId.get(hover); row?.parentId !== undefined; row = byId.get(row.parentId)) set.add(row.parentId);
    const down = (id: string) => { for (const child of byId.get(id)?.childIds ?? []) { set.add(child); down(child); } };
    down(hover);
    return set;
  }, [hover, byId]);

  const toneOf = (row: DeckAgent): DeckTone => {
    if (replay === null) return row.tone;
    const lane = laneById.get(row.id);
    return lane ? laneToneAt(lane, replay) ?? row.tone : row.tone;
  };

  const cut = replay ?? Number.POSITIVE_INFINITY;
  const chords = useMemo(() => {
    if (comms.status !== "ready") return [];
    const pairs = new Map<string, { a: string; b: string; count: number }>();
    for (const message of comms.messages) {
      if (message.at > cut || message.broadcast) continue;
      for (const to of message.to) {
        const [a, b] = message.from < to ? [message.from, to] : [to, message.from];
        const key = `${a}|${b}`;
        const pair = pairs.get(key) ?? { a, b, count: 0 };
        pair.count += 1;
        pairs.set(key, pair);
      }
    }
    return [...pairs.values()];
  }, [comms, cut]);

  const [clock, setClock] = useState(() => Date.now());
  const flying = comms.status === "ready" && replay === null ? comms.messages.filter(message => clock - message.at < PACKET_MS && clock >= message.at - 50) : [];
  const anyFlying = comms.status === "ready" && replay === null && comms.messages.some(message => Date.now() - message.at < PACKET_MS);
  useFrameLoop(anyFlying, boxRef, () => { setClock(Date.now()); return comms.status === "ready" && comms.messages.some(message => Date.now() - message.at < PACKET_MS); });

  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  useWheel(boxRef, event => {
    event.preventDefault();
    const rect = boxRef.current!.getBoundingClientRect();
    const sx = event.clientX - rect.left, sy = event.clientY - rect.top;
    const zoom = Math.max(0.5, Math.min(3, ui.zoom * (event.deltaY > 0 ? 1 / 1.12 : 1.12)));
    const wx = cx + (sx - cx - ui.x) / ui.zoom, wy = cy + (sy - cy - ui.y) / ui.zoom;
    onOrbit({ zoom, x: sx - cx - (wx - cx) * zoom, y: sy - cy - (wy - cy) * zoom });
  });
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-node]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: ui.x, oy: ui.y };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onOrbit({ x: state.ox + event.clientX - state.x, y: state.oy + event.clientY - state.y });
  };
  const reset = () => onOrbit({ zoom: 1, x: 0, y: 0 });
  const moved = ui.zoom !== 1 || ui.x !== 0 || ui.y !== 0;

  // Nodes grow with the room the stage gives each ring, within reading sizes.
  const scale = Math.max(0.9, Math.min(1.45, gap / 105));
  const radius = (row: DeckAgent) => (row.main ? 22 : 13 + Math.min(6, Math.log10(1 + (row.tokens ?? 0) / 1000) * 3)) * scale;
  const visibleRows = rows.filter(row => points.has(row.id));
  return <div className="ad-orbit" ref={boxRef} data-focus={lit ? "" : undefined}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null; }}
    onDoubleClick={event => { if (!(event.target as Element).closest("[data-node]")) reset(); }}>
    {width > 0 ? <svg ref={svgRef} width={width} height={height} className="ad-orbit-svg" role="img" aria-label={d("views.orbit")}>
      <g transform={`translate(${ui.x.toFixed(1)} ${ui.y.toFixed(1)}) translate(${cx} ${cy}) scale(${ui.zoom}) translate(${-cx} ${-cy})`}>
        <g className="ad-orbit-rings">
          {Array.from({ length: layout.rings }, (_, index) => <ellipse key={index} cx={cx} cy={cy} rx={(index + 1) * gapX} ry={(index + 1) * gapY} />)}
        </g>
        <g className="ad-orbit-chords">
          {chords.map(({ a, b, count }) => {
            const pa = points.get(a), pb = points.get(b);
            if (!pa || !pb) return null;
            const on = lit === null || (lit.has(a) && lit.has(b));
            return <path key={`${a}|${b}`} d={orbitChordPath(pa.x, pa.y, pb.x, pb.y, cx, cy)} style={{ strokeWidth: 1 + Math.min(3, count * 0.55) }} data-dimmed={!on || undefined}>
              <title>{`${byId.get(a)?.name ?? a} ↔ ${byId.get(b)?.name ?? b} · ${d("comms.count", { count })}`}</title>
            </path>;
          })}
        </g>
        <g className="ad-orbit-edges">
          {visibleRows.map(row => {
            if (row.parentId === undefined) return null;
            const from = points.get(row.parentId), to = points.get(row.id);
            if (!from || !to) return null;
            const tone = toneOf(row);
            return <path key={row.id} d={orbitEdgePath(from.x, from.y, to.x, to.y, cx, cy)} data-tone={tone}
              data-dimmed={(lit !== null && !(lit.has(row.id) && lit.has(row.parentId))) || !matched.has(row.id) || undefined}
              style={sigilStyle({ id: row.id, name: row.name, hue: row.hue, main: row.main })} />;
          })}
        </g>
        <g className="ad-orbit-packets">
          {flying.flatMap(message => message.to.map(to => {
            const from = points.get(message.from), dest = points.get(to);
            if (!from || !dest) return null;
            const t = Math.max(0, Math.min(1, (clock - message.at) / PACKET_MS));
            const mx = (from.x + dest.x) / 2, my = (from.y + dest.y) / 2;
            const p = quadPoint(from.x, from.y, mx + (cx - mx) * 0.55, my + (cy - my) * 0.55, dest.x, dest.y, t);
            return <circle key={`${message.id}:${to}`} cx={p.x} cy={p.y} r={message.broadcast ? 2.4 : 3.2} data-broadcast={message.broadcast || undefined} style={{ opacity: Math.min(1, (1 - t) * 3) }} />;
          }))}
        </g>
        {visibleRows.map(row => {
          const point = points.get(row.id)!;
          const r = radius(row);
          const tone = toneOf(row);
          const art = r * (row.main ? 1.2 : 1.24);
          const selected = selectedId === row.id;
          return <g key={row.id} className="ad-orbit-node" data-node={row.id} data-tone={tone} data-main={row.main || undefined}
            data-selected={selected || undefined} data-dimmed={(lit !== null && !lit.has(row.id)) || !matched.has(row.id) || undefined}
            transform={`translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`} style={sigilStyle({ id: row.id, name: row.name, hue: row.hue, main: row.main })}
            tabIndex={0} role="button" aria-label={`${row.name} · ${row.statusText}`} aria-pressed={selected}
            onPointerEnter={() => setHover(row.id)} onPointerLeave={() => setHover(current => current === row.id ? null : current)}
            onFocus={() => setHover(row.id)} onBlur={() => setHover(null)}
            onClick={() => onSelect(row.id)} onDoubleClick={() => onOpen(row)}
            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); onOpen(row); } else if (event.key === " ") { event.preventDefault(); onSelect(row.id); } }}>
            <title>{[row.name, row.statusText, row.model ?? row.modelLabel, row.stage, row.tokens === undefined ? undefined : `${formatTokens(row.tokens)} tokens`].filter(Boolean).join("\n")}</title>
            {tone === "running" && replay === null ? <circle className="ad-orbit-ripple" r={r + 3} /> : null}
            <circle className="ad-orbit-halo" r={r + 6} />
            <circle className="ad-orbit-track" r={r + 3} />
            {row.progress !== undefined ? <circle className="ad-orbit-progress" r={r + 3} pathLength={100} transform="rotate(-90)"
              strokeDasharray={`${Math.max(0.001, row.progress * 100).toFixed(2)} 100`} /> : null}
            <circle className="ad-orbit-disc" r={r} />
            <SigilArt identity={{ id: row.id, name: row.name, hue: row.hue, main: row.main }} tone={tone} x={-art / 2} y={-art / 2} size={art} />
            <circle className="ad-orbit-dot" cx={r * 0.74} cy={r * 0.74} r={3.4} />
            <text className="ad-orbit-name" y={r + 15} textAnchor="middle">{row.name.length > 18 ? `${row.name.slice(0, 17)}…` : row.name}</text>
          </g>;
        })}
      </g>
    </svg> : null}
    <div className="ad-orbit-legend" aria-hidden="true">
      <span><i className="is-spawn" />{d("orbit.legendSpawn")}</span>
      <span data-pending={comms.status !== "ready" || undefined}><i className="is-comms" />{comms.status === "ready" ? d("orbit.legendComms") : d("orbit.commsPending")}</span>
    </div>
    <div className="ad-orbit-zoom">
      <button type="button" className="icon-btn small" aria-label={d("timeline.zoomOut")} data-tip={d("timeline.zoomOut")} onClick={() => onOrbit({ zoom: Math.max(0.5, ui.zoom / 1.25) })}><Icon name="minimize" extra="sm" /></button>
      <button type="button" className="icon-btn small" aria-label={d("timeline.zoomIn")} data-tip={d("timeline.zoomIn")} onClick={() => onOrbit({ zoom: Math.min(3, ui.zoom * 1.25) })}><Icon name="plus" extra="sm" /></button>
      <button type="button" className="icon-btn small" aria-label={d("orbit.fit")} data-tip={d("orbit.fit")} disabled={!moved} onClick={reset}><Icon name="expand" extra="sm" /></button>
    </div>
  </div>;
}

import { memo, type CSSProperties } from "react";
import type { DeckTone } from "./deckModel";
import { SIGIL_GRID, sigilHash, sigilSpec, type SigilCell } from "./sigil";

/** Hue angles for the ten sigil colours, spaced so neighbours never read as the same agent. */
export const SIGIL_HUE_DEG = [22, 52, 84, 146, 176, 204, 232, 262, 296, 334] as const;

export type SigilIdentity = { readonly id: string; readonly name: string; readonly hue: number; readonly main: boolean };

function cellsPath(cells: readonly SigilCell[], part: SigilCell["part"] | readonly SigilCell["part"][]): string {
  const parts = Array.isArray(part) ? part : [part];
  return cells.filter(cell => parts.includes(cell.part)).map(cell => `M${cell.x} ${cell.y}h1v1h-1z`).join("");
}

/** Eyes close (a low slit) once an agent has stopped working; failure turns them red. */
function eyesPath(eyes: readonly SigilCell[], closed: boolean): string {
  return eyes.map(cell => closed ? `M${cell.x} ${cell.y + 0.55}h1v0.35h-1z` : `M${cell.x} ${cell.y}h1v1h-1z`).join("");
}

export function sigilStyle(identity: SigilIdentity): CSSProperties {
  const phase = (sigilHash(`blink:${identity.id}`) % 100) / 100;
  return {
    ["--sg-h" as string]: identity.main ? 260 : SIGIL_HUE_DEG[identity.hue % SIGIL_HUE_DEG.length],
    ["--sg-phase" as string]: phase.toFixed(2),
  };
}

/**
 * The pixel face in SVG user space: `size` units square at (x, y). Used inside
 * the orbit's own SVG; {@link AgentSigil} wraps it for HTML.
 */
export const SigilArt = memo(function SigilArt({ identity, tone, x = 0, y = 0, size }: { identity: SigilIdentity; tone: DeckTone; x?: number; y?: number; size: number }) {
  const spec = sigilSpec(identity.id, identity.main);
  const scale = size / SIGIL_GRID;
  const closed = tone === "idle" || tone === "parked" || tone === "stopped";
  return <g className="sg-art" transform={`translate(${x} ${y}) scale(${scale})`} shapeRendering="crispEdges">
    <path className="sg-head" d={cellsPath(spec.cells, "head")} />
    <path className="sg-mouth" d={cellsPath(spec.cells, "mouth")} />
    <path className="sg-crown" d={cellsPath(spec.cells, "crown")} />
    <path className="sg-beacon" d={cellsPath(spec.cells, "beacon")} />
    <path className={`sg-eyes${closed ? " is-closed" : ""}`} d={eyesPath(spec.eyes, closed)} />
  </g>;
});

/**
 * An agent's sigil tile. `ring` draws the progress border around the tile: the
 * task's own estimate, or the share of delivered prompt groups.
 */
export const AgentSigil = memo(function AgentSigil({ identity, tone, size, progress, ring = false, className }: {
  identity: SigilIdentity; tone: DeckTone; size: number; progress?: number | undefined; ring?: boolean; className?: string;
}) {
  const radius = Math.round(size * 0.3);
  // Whole-pixel cells where the tile allows it, so the face stays crisp at 1×.
  const cell = size >= 24 ? Math.round(size * 0.7 / 7) : size * 0.72 / 7;
  const art = cell * 7;
  const offset = Math.round((size - art) / 2);
  const showRing = ring && progress !== undefined;
  return <span className={`sg${identity.main ? " is-main" : ""}${className ? ` ${className}` : ""}`} data-tone={tone}
    style={{ ...sigilStyle(identity), width: size, height: size, borderRadius: radius }} aria-hidden="true">
    <svg className="sg-tile" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <SigilArt identity={identity} tone={tone} x={offset} y={offset} size={art} />
      {showRing ? <>
        <rect className="sg-ring-track" x={0.75} y={0.75} width={size - 1.5} height={size - 1.5} rx={radius - 0.75} />
        <rect className="sg-ring" x={0.75} y={0.75} width={size - 1.5} height={size - 1.5} rx={radius - 0.75} pathLength={100}
          strokeDasharray={`${Math.max(0.001, progress * 100).toFixed(2)} 100`} />
      </> : null}
    </svg>
  </span>;
});

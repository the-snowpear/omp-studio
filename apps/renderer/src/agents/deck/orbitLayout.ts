import type { DeckAgent } from "./deckModel";

/**
 * Radial tree. The root sits in the middle, each generation on its own ring,
 * and every subtree owns an angular wedge sized by how many leaves it carries,
 * so siblings never overlap and a deep branch gets room to fan out.
 *
 * Positions depend only on the tree (who spawned whom, in spawn order). A status
 * or usage update never moves a node; a new agent re-divides its parent's wedge.
 * Coordinates are in ring units: the root is (0, 0) and generation n sits at
 * radius n. The view scales them to its own size.
 */
export type OrbitNode = { readonly id: string; readonly x: number; readonly y: number; readonly ring: number; readonly angle: number };
export type OrbitLayout = { readonly nodes: ReadonlyMap<string, OrbitNode>; readonly rings: number; readonly virtualRoot: boolean };

const START = -Math.PI / 2;

export function orbitLayout(rows: readonly DeckAgent[]): OrbitLayout {
  const byId = new Map(rows.map(row => [row.id, row]));
  const roots = rows.filter(row => row.parentId === undefined || !byId.has(row.parentId));
  const children = (id: string | null) => id === null ? roots : (byId.get(id)?.childIds ?? []).map(child => byId.get(child)).filter((row): row is DeckAgent => row !== undefined);
  const leaves = new Map<string, number>();
  const countLeaves = (row: DeckAgent): number => {
    const own = children(row.id);
    const count = own.length === 0 ? 1 : own.reduce((sum, child) => sum + countLeaves(child), 0);
    leaves.set(row.id, count);
    return count;
  };
  for (const root of roots) countLeaves(root);

  const nodes = new Map<string, OrbitNode>();
  let rings = 0;
  // One real root (the main agent) takes the centre; several roots orbit an empty centre.
  const virtualRoot = roots.length !== 1;
  const place = (row: DeckAgent, ring: number, from: number, to: number) => {
    const angle = ring === 0 ? START : (from + to) / 2;
    nodes.set(row.id, { id: row.id, ring, angle, x: Math.cos(angle) * ring, y: Math.sin(angle) * ring });
    rings = Math.max(rings, ring);
    const own = children(row.id);
    const total = own.reduce((sum, child) => sum + (leaves.get(child.id) ?? 1), 0);
    // The first ring may use the whole circle; deeper rings stay inside their parent's wedge.
    const span = ring === 0 ? Math.PI * 2 : to - from;
    // Around the centre one or two children sit straight above (and below) it; more fan out from
    // the top-right, so no child lands level with the centre's own label.
    let cursor = ring === 0 && own.length <= 2 ? START - span * (leaves.get(own[0]?.id ?? "") ?? 1) / Math.max(1, total) / 2 : ring === 0 ? START : from;
    for (const child of own) {
      const share = span * (leaves.get(child.id) ?? 1) / Math.max(1, total);
      place(child, ring + 1, cursor, cursor + share);
      cursor += share;
    }
  };
  if (virtualRoot) {
    const total = roots.reduce((sum, root) => sum + (leaves.get(root.id) ?? 1), 0);
    let cursor = START - Math.PI * (leaves.get(roots[0]?.id ?? "") ?? 1) / Math.max(1, total);
    for (const root of roots) {
      const share = Math.PI * 2 * (leaves.get(root.id) ?? 1) / Math.max(1, total);
      place(root, 1, cursor, cursor + share);
      cursor += share;
    }
  } else if (roots[0]) place(roots[0], 0, START, START + Math.PI * 2);
  return { nodes, rings, virtualRoot };
}

/** A gentle arc between two nodes, bowed away from the centre (cx, cy) so edges never cut through it. */
export function orbitEdgePath(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, bow = 0.18): string {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const sign = (mx - cx) * -dy + (my - cy) * dx >= 0 ? 1 : -1;
  const qx = mx - dy * bow * sign, qy = my + dx * bow * sign;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

/** A chord between two peers, bowed toward the centre: it reads as talk, not lineage. */
export function orbitChordPath(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number): string {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const qx = mx + (cx - mx) * 0.55, qy = my + (cy - my) * 0.55;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${qx.toFixed(1)} ${qy.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

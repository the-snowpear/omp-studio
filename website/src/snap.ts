// Where snapped windows go, as fractions of the desk. No DOM here: the workbench asks, and moves.
export type Cell = [x: number, y: number, w: number, h: number];

export const FULL: Cell = [0, 0, 1, 1];
const E = 0.012;

export const overlaps = (a: Cell, b: Cell) =>
  a[0] < b[0] + b[2] - E && b[0] < a[0] + a[2] - E && a[1] < b[1] + b[3] - E && b[1] < a[1] + a[3] - E;

export type ZoneName = "left" | "right" | "tl" | "tr" | "bl" | "br";

/** The two columns and their rows, following whatever proportions are already on the desk. */
export function zones(taken: Cell[]): Record<ZoneName, Cell> {
  const column = taken.find((c) => c[0] < E && c[2] < 1 - E)?.[2] ?? taken.find((c) => c[0] > E && c[0] + c[2] > 1 - E)?.[0] ?? 0.5;
  const x = Math.min(Math.max(column, 0.25), 0.75);
  const row = (side: Cell[]) => side.find((c) => c[1] < E && c[3] < 1 - E)?.[3] ?? side.find((c) => c[1] > E)?.[1] ?? 0.5;
  const l = row(taken.filter((c) => c[0] + c[2] <= x + E));
  const r = row(taken.filter((c) => c[0] >= x - E));
  return {
    left: [0, 0, x, 1],
    right: [x, 0, 1 - x, 1],
    tl: [0, 0, x, l],
    bl: [0, l, x, 1 - l],
    tr: [x, 0, 1 - x, r],
    br: [x, r, 1 - x, 1 - r],
  };
}

/** The largest free place left beside `taken`, or null when the desk is full. */
export function vacancy(taken: Cell[]): Cell | null {
  const z = zones(taken);
  const places: Cell[] = [z.right, z.left, [0, 0, 1, 0.5], [0, 0.5, 1, 0.5], z.tr, z.br, z.tl, z.bl];
  return places
    .filter((p) => taken.every((t) => !overlaps(p, t)))
    .sort((a, b) => b[2] * b[3] - a[2] * a[3])[0] ?? null;
}

/** What is left of `a` once `b` has taken a whole end of it; null when that is not a rectangle. */
function remainder(a: Cell, b: Cell): Cell | null {
  const near = (p: number, q: number) => Math.abs(p - q) < E;
  if (near(a[0], b[0]) && near(a[2], b[2]) && b[3] < a[3] - E) {
    if (near(a[1], b[1])) return [a[0], b[1] + b[3], a[2], a[3] - b[3]];
    if (near(a[1] + a[3], b[1] + b[3])) return [a[0], a[1], a[2], a[3] - b[3]];
  }
  if (near(a[1], b[1]) && near(a[3], b[3]) && b[2] < a[2] - E) {
    if (near(a[0], b[0])) return [b[0] + b[2], a[1], a[2] - b[2], a[3]];
    if (near(a[0] + a[2], b[0] + b[2])) return [a[0], a[1], a[2] - b[2], a[3]];
  }
  return null;
}

/** Where the windows already snapped go when one takes `cell`: the other half of their own place, the largest space left, or (null) back to floating. */
export function displace<T>(others: [T, Cell][], cell: Cell): Map<T, Cell | null> {
  const taken: Cell[] = [cell, ...others.filter(([, c]) => !overlaps(c, cell)).map(([, c]) => c)];
  const moves = new Map<T, Cell | null>();
  for (const [key, c] of others) {
    if (!overlaps(c, cell)) continue;
    const rest = remainder(c, cell);
    const to = rest && taken.every((t) => !overlaps(rest, t)) ? rest : vacancy(taken);
    moves.set(key, to);
    if (to) taken.push(to);
  }
  return moves;
}

export interface Divider {
  axis: "x" | "y";
  at: number;
  from: number;
  to: number;
  /** Indexes of the cells that end at it, and of those that start at it. */
  before: number[];
  after: number[];
  min: number;
  max: number;
  /** Halfway between the far edges of its two sides. */
  even: number;
}

/** The shared edges of a set of cells. Moving one resizes every cell that meets it. */
export function dividers(cells: Cell[], minW: number, minH: number): Divider[] {
  const found: Divider[] = [];
  for (const axis of ["x", "y"] as const) {
    const p = axis === "x" ? 0 : 1;
    const s = p + 2;
    const q = 1 - p;
    const t = q + 2;
    const least = axis === "x" ? minW : minH;
    const groups: { at: number; before: Set<number>; after: Set<number>; from: number; to: number }[] = [];
    cells.forEach((a, n) => cells.forEach((b, m) => {
      if (n === m || Math.abs(a[p]! + a[s]! - b[p]!) > E) return;
      const from = Math.max(a[q]!, b[q]!);
      const to = Math.min(a[q]! + a[t]!, b[q]! + b[t]!);
      if (to - from < E) return;
      const at = b[p]!;
      const span = { from: Math.min(a[q]!, b[q]!), to: Math.max(a[q]! + a[t]!, b[q]! + b[t]!) };
      // One column edge runs the height of the desk; row edges belong to their own column.
      const group = groups.find((g) => Math.abs(g.at - at) < E && (axis === "x" || g.before.has(n) || g.after.has(m)));
      if (!group) return groups.push({ at, before: new Set([n]), after: new Set([m]), ...span });
      group.before.add(n);
      group.after.add(m);
      group.from = Math.min(group.from, span.from);
      group.to = Math.max(group.to, span.to);
      return;
    }));
    for (const g of groups) {
      const lo = Math.max(...[...g.before].map((n) => cells[n]![p]!));
      const hi = Math.min(...[...g.after].map((n) => cells[n]![p]! + cells[n]![s]!));
      found.push({ axis, at: g.at, from: g.from, to: g.to, before: [...g.before], after: [...g.after], min: lo + least, max: hi - least, even: (lo + hi) / 2 });
    }
  }
  return found;
}

/** Cells after a divider has moved to `at`. */
export function shift(cells: Cell[], d: Divider, at: number): Cell[] {
  const v = Math.min(Math.max(at, d.min), Math.max(d.min, d.max));
  const p = d.axis === "x" ? 0 : 1;
  const s = p + 2;
  return cells.map((c, n) => {
    const next: Cell = [...c];
    if (d.before.includes(n)) next[s] = v - c[p]!;
    if (d.after.includes(n)) {
      next[s] = c[p]! + c[s]! - v;
      next[p] = v;
    }
    return next;
  });
}

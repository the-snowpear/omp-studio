/**
 * Pixel sigils: a small robot face per agent, drawn on a 7×7 grid and mirrored
 * around the middle column. Every trait comes from a stable hash of the agent's
 * identity, so the same agent wears the same face in every view and session.
 *
 * The face is built from a template rather than random noise: a head block with
 * eyes and a mouth cut out of it always reads as a face, and the variants
 * (antenna, corners, ears, eye style, mouth, jaw, shoulders) give ~1,700 shapes
 * before the ten hues multiply them.
 */

export const SIGIL_GRID = 7;
export const SIGIL_HUES = 10;

export type SigilCell = { readonly x: number; readonly y: number; readonly part: "head" | "eye" | "mouth" | "beacon" | "crown" };
export type SigilSpec = { readonly cells: readonly SigilCell[]; readonly eyes: readonly SigilCell[] };

/** FNV-1a: small, fast and well spread for short identifiers. */
export function sigilHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function sigilHue(seed: string): number {
  return sigilHash(`hue:${seed}`) % SIGIL_HUES;
}

const MAX_SIGIL_CACHE = 1024;
const cache = new Map<string, SigilSpec>();

/** `commander` is the main agent: a crowned, symmetric face that no child can draw. */
export function sigilSpec(seed: string, commander = false): SigilSpec {
  const key = `${commander ? 1 : 0}:${seed}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const bits = sigilHash(seed);
  const bit = (index: number) => (bits >>> index) & 1;
  const pick = (index: number, count: number) => ((bits >>> index) & 0xff) % count;
  const cells: SigilCell[] = [];
  const eyes: SigilCell[] = [];
  const add = (x: number, y: number, part: SigilCell["part"]) => {
    const cell = { x, y, part };
    if (part === "eye") eyes.push(cell); else cells.push(cell);
  };
  const mirror = (x: number, y: number, part: SigilCell["part"]) => {
    add(x, y, part);
    if (x !== 3) add(6 - x, y, part);
  };

  const antenna = commander ? 3 : pick(0, 3);           // 0 single, 1 double, 2 none
  const rounded = commander || bit(3) === 1;
  const ears = !commander && bit(4) === 1;
  // Two eyes always: a face with one reads as an insect, not a robot.
  const eyeStyle = commander ? 0 : [0, 0, 0, 1, 1, 2][pick(6, 6)]!; // 0 dots, 1 tall, 2 visor
  const eyeRow = commander ? 2 : eyeStyle === 1 ? 2 : 2 + bit(5);
  const mouth = commander ? 0 : pick(9, 4);             // 0 line, 1 dot, 2 grille, 3 none
  const narrowJaw = !commander && bit(12) === 1;
  const body = commander ? 2 : pick(13, 3);             // 0 none, 1 neck, 2 shoulders

  // Crown or antenna on row 0. The commander's crown is three points.
  if (antenna === 3) { mirror(1, 0, "crown"); add(3, 0, "crown"); }
  else if (antenna === 0) add(3, 0, "beacon");
  else if (antenna === 1) mirror(2, 0, "beacon");

  const eyeColumns = eyeStyle === 2 ? [2, 3, 4] : [2, 4];
  const eyeRows = eyeStyle === 1 ? [eyeRow, eyeRow + 1] : [eyeRow];
  const mouthColumns = mouth === 0 ? [2, 3, 4] : mouth === 1 ? [3] : mouth === 2 ? [2, 4] : [];
  const mouthRow = eyeRows[eyeRows.length - 1]! + 2;
  for (let y = 1; y <= 5; y += 1) {
    for (let x = 1; x <= 5; x += 1) {
      const corner = (x === 1 || x === 5) && (y === 1 || (y === 5 && narrowJaw));
      if (corner && (rounded || y === 5)) continue;
      if (eyeRows.includes(y) && eyeColumns.includes(x)) { add(x, y, "eye"); continue; }
      if (y === mouthRow && mouthRow <= 5 && mouthColumns.includes(x)) { add(x, y, "mouth"); continue; }
      add(x, y, "head");
    }
  }
  if (ears) mirror(0, 3, "head");
  if (body === 1) add(3, 6, "head");
  else if (body === 2) { mirror(2, 6, "head"); add(3, 6, "head"); if (!narrowJaw) mirror(1, 6, "head"); }

  const spec = { cells, eyes };
  if (cache.size >= MAX_SIGIL_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, spec);
  return spec;
}

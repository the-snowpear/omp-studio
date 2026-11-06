/** The π mark from the app icon. Geometry measured from icon.png (1024 px), normalised to a 100-unit box. */
export const PI = {
  /** [x, y, w, h] of the three bars, in a 100 x 94 box. */
  bars: [
    [0, 0, 100, 21],
    [17.5, 0, 19.5, 70],
    [56.8, 0, 19.5, 93.5],
  ] as const,
  stops: ["#f24fd6", "#9c55ff", "#4cc4ff"] as const,
};

/** Solid mark as one path, for masks and small sizes. */
export const PI_PATH = "M2 0H98a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H76.3V91a2.5 2.5 0 0 1-2.5 2.5H59.3a2.5 2.5 0 0 1-2.5-2.5V21H37V67.5a2.5 2.5 0 0 1-2.5 2.5H20a2.5 2.5 0 0 1-2.5-2.5V21H2a2 2 0 0 1-2-2V2A2 2 0 0 1 2 0Z";

export function piSvg(size: number, id = "pi"): string {
  return `<svg width="${size}" height="${Math.round((size * 94) / 100)}" viewBox="0 0 100 94" aria-hidden="true"><defs><linearGradient id="${id}" x1="5" y1="0" x2="80" y2="94" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${PI.stops[0]}"/><stop offset=".55" stop-color="${PI.stops[1]}"/><stop offset="1" stop-color="${PI.stops[2]}"/></linearGradient></defs><path d="${PI_PATH}" fill="url(#${id})"/></svg>`;
}

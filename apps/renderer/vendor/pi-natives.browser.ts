// Browser stand-in for `@oh-my-pi/pi-natives`. The real package runs one
// `loadNative()` at module scope that needs `process` and a Bun/Node loader,
// so bundling it into the sandboxed renderer would throw on chunk load. The
// renderer only reaches it through the figure code path (`rasterizeSvg`,
// terminal raster for `figureRaster`); the browser draws the SVG itself, so
// any call that does need the native rasterizer reports it instead of
// silently degrading.

const unavailable = (name: string): never => {
  throw new Error(`${name} needs the native runtime and is unavailable in the browser`);
};

export async function rasterizeSvg(
  _input: Uint8Array,
  _maxWidthPx: number,
  _maxHeightPx: number,
  _scale?: number | null,
  _cell?: { w: number; h: number } | null,
): Promise<Uint8Array> {
  return unavailable("rasterizeSvg");
}

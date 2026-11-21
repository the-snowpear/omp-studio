import { useLayoutEffect, useRef } from "react";
import { motionMs, motionReduced } from "../motion";
import {
  ACTIVITY_GLYPH_POSE,
  activityGlyphEase,
  createActivityGlyphPainter,
  type ActivityGlyphKind,
} from "./activityGlyphDrawing";

const SIZE = 14;
const frames = new Set<(now: number, reduced: boolean) => void>();
let frame: number | undefined;

function tick(now: number) {
  frame = undefined;
  const reduced = motionReduced();
  for (const paint of frames) paint(now, reduced);
  if (frames.size > 0) frame = requestAnimationFrame(tick);
}

function subscribe(paint: (now: number, reduced: boolean) => void): () => void {
  frames.add(paint);
  paint(performance.now(), motionReduced());
  if (frame === undefined) frame = requestAnimationFrame(tick);
  return () => {
    frames.delete(paint);
    if (frames.size === 0 && frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  };
}

function layer() {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  return ctx === null ? null : { canvas, ctx, draw: createActivityGlyphPainter(ctx) };
}
type Layer = NonNullable<ReturnType<typeof layer>>;

function paintLayer(target: Layer, glyph: ActivityGlyphKind, t: number, color: string, dpr: number) {
  const { canvas, ctx, draw } = target;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr * SIZE / 16, 0, 0, dpr * SIZE / 16, 0, 0);
  draw(glyph, t, color);
  ctx.restore();
}

/** Two isolated drawing layers keep pencil / magnifier erasure out of the other glyph. */
export function ActivityGlyph({ glyph }: { glyph: ActivityGlyphKind }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const change = useRef<((next: ActivityGlyphKind) => void) | undefined>(undefined);

  useLayoutEffect(() => {
    // Avoid jsdom's unimplemented getContext warning; retain the decorative slot.
    if (typeof CanvasRenderingContext2D === "undefined") return;
    const canvas = canvasRef.current!, ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const incoming = layer(), outgoing = layer();
    if (incoming === null || outgoing === null) return;
    let current = glyph, previous: ActivityGlyphKind | "snapshot" | undefined;
    let changedAt = 0, duration = 0, pixelRatio = 0, dirty = true, wasReduced = false;
    let accent = getComputedStyle(canvas).getPropertyValue("--accent").trim();

    const paint = (now: number, reduced: boolean) => {
      const dpr = window.devicePixelRatio || 1;
      if (dpr !== pixelRatio) {
        pixelRatio = dpr;
        for (const surface of [canvas, incoming.canvas, outgoing.canvas]) {
          surface.width = Math.round(SIZE * dpr); surface.height = Math.round(SIZE * dpr);
        }
        if (previous === "snapshot") previous = undefined;
        dirty = true;
      }
      if (reduced) previous = undefined;
      if (reduced && wasReduced && !dirty) return;
      wasReduced = reduced;
      dirty = false;
      const t = reduced ? ACTIVITY_GLYPH_POSE[current] : now / 1000;
      const alpha = previous === undefined ? 1 : activityGlyphEase(Math.min(1, (now - changedAt) / duration));
      paintLayer(incoming, current, t, accent, dpr);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (previous !== undefined && alpha < 1) {
        if (previous !== "snapshot") paintLayer(outgoing, previous, now / 1000, accent, dpr);
        ctx.globalAlpha = 1 - alpha;
        ctx.drawImage(outgoing.canvas, 0, 0);
      } else previous = undefined;
      ctx.globalAlpha = alpha;
      ctx.drawImage(incoming.canvas, 0, 0);
      ctx.restore();
    };

    change.current = next => {
      if (next === current) return;
      const now = performance.now();
      const reduced = motionReduced();
      // Preserve the visible blend if another operation starts before it finishes.
      if (!reduced && previous !== undefined && now - changedAt < duration) {
        outgoing.ctx.save();
        outgoing.ctx.setTransform(1, 0, 0, 1, 0, 0);
        outgoing.ctx.clearRect(0, 0, outgoing.canvas.width, outgoing.canvas.height);
        outgoing.ctx.drawImage(canvas, 0, 0);
        outgoing.ctx.restore();
        previous = "snapshot";
      } else previous = reduced ? undefined : current;
      current = next;
      changedAt = now;
      duration = motionMs("slower");
      dirty = true;
      paint(now, reduced);
    };
    // The same data-theme signal used by terminal canvases; never read styles per frame.
    const themes = new MutationObserver(() => {
      accent = getComputedStyle(canvas).getPropertyValue("--accent").trim();
      dirty = true;
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const unsubscribe = subscribe(paint);
    return () => {
      change.current = undefined;
      themes.disconnect();
      unsubscribe();
    };
  }, []);

  useLayoutEffect(() => change.current?.(glyph), [glyph]);

  return <canvas ref={canvasRef} className="al-glyph" aria-hidden="true" data-glyph={glyph} width={SIZE} height={SIZE} />;
}

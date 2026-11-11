/**
 * Motion for code: the numbers CSS spends, and the one answer to "is motion off".
 *
 * The values live in the Motion block of `styles/tokens.css` and the patterns
 * that use them in `styles/motion.css`. This module mirrors the numbers for the
 * two things CSS cannot do by itself: timers that must end with an animation
 * (unmount after the leave, swap after the fade) and WAAPI calls. Nothing else
 * in the renderer writes a duration or a curve as a literal;
 * `scripts/check-renderer-motion.mjs` fails when this table and the stylesheet
 * drift apart.
 */

/** The rhythm ladder `--dur-tactile` … `--dur-hero`, and `--dur-flash`. */
export const MOTION_MS = {
  tactile: 80,
  fast: 120,
  base: 180,
  slow: 250,
  slower: 320,
  hero: 480,
  flash: 900,
} as const;

export type MotionStep = keyof typeof MOTION_MS;

/** The curves `--ease` … `--ease-emphasis` (the spring and the loop curve are CSS-only). */
export const MOTION_EASE = {
  standard: "cubic-bezier(0.25, 0.1, 0.25, 1)",
  out: "cubic-bezier(0.16, 0.84, 0.44, 1)",
  in: "cubic-bezier(0.5, 0, 0.75, 0)",
  nav: "cubic-bezier(0.32, 0.72, 0, 1)",
  ios: "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
  emphasis: "cubic-bezier(0.38, 0, 0.08, 1)",
} as const;

export type MotionCurve = keyof typeof MOTION_EASE;

/** `--stagger`: the gap between the items of a cascade. */
export const STAGGER_MS = 40;

/** `--tip-delay`: how long a pointer rests on a control before its tip shows. */
export const TIP_DELAY_MS = 500;

/**
 * A timer that unmounts something after its leave animation waits this much
 * longer than the animation, so the last frame is painted before the node goes.
 */
export const MOTION_SLACK_MS = 40;

/** CSS collapses transitions to 0s and animations to 0.01ms when motion is off; anything this short is "no animation". */
export const INSTANT_MS = 20;

/**
 * True when motion is off: the reduced tier (`data-perf-tier~="L1"`, which the
 * renderer entry sets for the OS preference, the `omp.perf.motion` switch and
 * low machine tiers alike) or the OS preference itself in a document that never
 * ran tier control. It is the same pair of triggers as the "Reduced motion"
 * block in `styles/motion.css`, so a timer can never outlast the animation it
 * waits for.
 */
export function motionReduced(): boolean {
  if (typeof document !== "undefined" && document.documentElement.matches('[data-perf-tier~="L1"]')) return true;
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** How long to wait for a step of the ladder: 0 when motion is off. */
export function motionMs(step: MotionStep): number {
  return motionReduced() ? 0 : MOTION_MS[step];
}

function firstTime(value: string, fallback: number): number {
  const raw = value.split(",")[0]?.trim() ?? "";
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return raw.endsWith("ms") ? parsed : parsed * 1000;
}

/**
 * The duration of the element's own first transition, in milliseconds.
 *
 * For choreography that follows one element's clock (the avatar flying while
 * the rail slides, panels re-measuring while it moves): read the clock instead
 * of naming it twice. Under reduced motion this comes back as ~0 and callers
 * take the "just swap" path (compare with {@link INSTANT_MS}).
 */
export function transitionMs(element: HTMLElement): number {
  return firstTime(getComputedStyle(element).transitionDuration, MOTION_MS.slow);
}

/** The delay of the element's first transition, for unmount timers that must cover it. */
export function transitionDelayMs(element: HTMLElement): number {
  return firstTime(getComputedStyle(element).transitionDelay, 0);
}

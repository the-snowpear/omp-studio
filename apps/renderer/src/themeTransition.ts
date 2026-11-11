import { MOTION_MS, motionReduced } from "./motion";

/** On `<html>` for the length of the dissolve; `styles/motion.css` keys the cross-fade off it. */
const TRANSITION_ATTRIBUTE = "data-theme-transition";

/** Each window owns its pending swap and the dissolve's cleanup. */
const transitions = new WeakMap<HTMLElement, {
  pending: (() => void) | null;
  active: ViewTransition | null;
}>();

/**
 * Change the theme as one dissolve of the whole window.
 *
 * Setting `data-theme` alone lets every surface go at its own pace: panels with
 * no colour transition snap on the first frame while the page background and
 * the borders that do have one are still fading a quarter of a second later, so
 * the window tears along its panel edges. A theme is the whole window changing
 * state, so it is cross-faded as a single snapshot instead (the "Theme" block
 * in `styles/motion.css`).
 *
 * The attribute is written inside the view transition's update callback. A
 * hidden window can suspend snapshot capture indefinitely, so a short timer
 * lands the theme anyway; with motion off, or without the API, it is a plain
 * attribute write.
 */
export function applyTheme(root: HTMLElement, theme: string): void {
  const state = transitions.get(root) ?? { pending: null, active: null };
  transitions.set(root, state);
  // A swap still waiting for this window's snapshot lands first.
  state.pending?.();
  if (root.getAttribute("data-theme") === theme) return;
  const document = root.ownerDocument;
  const view = document.defaultView;
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    if (state.pending === apply) state.pending = null;
    root.setAttribute("data-theme", theme);
  };
  if (view === null || typeof document.startViewTransition !== "function" || document.visibilityState !== "visible" || motionReduced()) {
    apply();
    return;
  }
  state.pending = apply;
  root.setAttribute(TRANSITION_ATTRIBUTE, "");
  const transition = document.startViewTransition(apply);
  state.active = transition;
  const fallback = view.setTimeout(() => {
    if (applied) return;
    transition.skipTransition();
    apply();
  }, MOTION_MS.fast);
  // Skipped (a newer transition started, the window was hidden): nothing to report.
  transition.ready.catch(() => undefined);
  void transition.finished.catch(() => undefined).then(() => {
    view.clearTimeout(fallback);
    apply();
    if (state.active !== transition) return;
    state.active = null;
    root.removeAttribute(TRANSITION_ATTRIBUTE);
  });
}

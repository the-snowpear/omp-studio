import { MOTION_MS, motionReduced } from "./motion";

/** On `<html>` for the length of the reveal; `styles/motion.css` keys the animation off it. */
const TRANSITION_ATTRIBUTE = "data-theme-transition";
/** Where the reveal starts and how far it must travel; read by the "Theme" block in `styles/motion.css`. */
const ORIGIN_PROPERTIES = ["--theme-x", "--theme-y", "--theme-reveal-end"] as const;
/** Must match `--theme-rim` in `styles/motion.css`: the circle only clears the corners once its feathered rim has passed them. */
const RIM_PX = 72;
/**
 * A theme change this soon after a press grows out of that press. Later than
 * this, something else changed the theme (another window, a sync), and the
 * window changes from its middle.
 */
const ORIGIN_FRESH_MS = 1500;

/** Each window owns its pending swap and the reveal's cleanup. */
const transitions = new WeakMap<HTMLElement, {
  pending: (() => void) | null;
  active: ViewTransition | null;
}>();

/** The last thing the user pressed in each document: a pointer position, or `null` for a key. */
const lastPress = new WeakMap<Document, { at: number; point: { x: number; y: number } | null }>();
const watched = new WeakSet<Document>();

function watchPresses(document: Document): void {
  const view = document.defaultView;
  if (view === null || watched.has(document)) return;
  watched.add(document);
  const now = () => view.performance.now();
  view.addEventListener("pointerdown", event => {
    lastPress.set(document, { at: now(), point: { x: event.clientX, y: event.clientY } });
  }, { capture: true, passive: true });
  view.addEventListener("keydown", event => {
    // Enter / Space on a focused control starts from that control; a shortcut
    // has no place of its own and starts from the middle.
    const active = document.activeElement;
    if (event.ctrlKey || event.metaKey || event.altKey || active === null || active === document.body || active === document.documentElement) {
      lastPress.set(document, { at: now(), point: null });
      return;
    }
    const box = active.getBoundingClientRect();
    lastPress.set(document, { at: now(), point: { x: box.left + box.width / 2, y: box.top + box.height / 2 } });
  }, { capture: true, passive: true });
}

if (typeof document !== "undefined") watchPresses(document);

function revealOrigin(document: Document, view: Window): { x: number; y: number } {
  const width = view.innerWidth;
  const height = view.innerHeight;
  const press = lastPress.get(document);
  const fresh = press?.point && view.performance.now() - press.at <= ORIGIN_FRESH_MS ? press.point : null;
  if (fresh === null) return { x: width / 2, y: height / 2 };
  return { x: Math.min(Math.max(fresh.x, 0), width), y: Math.min(Math.max(fresh.y, 0), height) };
}

/**
 * Change the theme as one movement of the whole window.
 *
 * Setting `data-theme` alone lets every surface go at its own pace: panels with
 * no colour transition snap on the first frame while the page background and
 * the borders that do have one are still fading a quarter of a second later, so
 * the window tears along its panel edges. A theme is the whole window changing
 * state, so the new one is revealed over a snapshot of the old: a circle that
 * grows from the control the user pressed (the "Theme" block in
 * `styles/motion.css`).
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
  const document = root.ownerDocument;
  watchPresses(document);
  if (root.getAttribute("data-theme") === theme) return;
  const view = document.defaultView;
  let applied = false;
  const apply = () => {
    if (applied) return;
    applied = true;
    if (state.pending === apply) state.pending = null;
    root.setAttribute("data-theme", theme);
  };
  if (view === null || typeof document.startViewTransition !== "function" || document.visibilityState !== "visible" || motionReduced() || root.getAttribute("data-embed") === "1") {
    apply();
    return;
  }
  const origin = revealOrigin(document, view);
  const reach = Math.hypot(Math.max(origin.x, view.innerWidth - origin.x), Math.max(origin.y, view.innerHeight - origin.y)) + RIM_PX;
  root.style.setProperty("--theme-x", `${origin.x}px`);
  root.style.setProperty("--theme-y", `${origin.y}px`);
  root.style.setProperty("--theme-reveal-end", `${Math.ceil(reach)}px`);
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
    for (const property of ORIGIN_PROPERTIES) root.style.removeProperty(property);
  });
}

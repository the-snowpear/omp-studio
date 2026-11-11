import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { applyTheme } from "./themeTransition";

const root = document.documentElement;
const previousTier = root.getAttribute("data-perf-tier");
const previousTheme = root.getAttribute("data-theme");
const frames: HTMLIFrameElement[] = [];
const resets: (() => void)[] = [];

function otherDocument(): Document {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  return frame.contentDocument!;
}

function transition(doc: Document, deferred = false) {
  vi.spyOn(doc, "visibilityState", "get").mockReturnValue("visible");
  const previous = Object.getOwnPropertyDescriptor(doc, "startViewTransition");
  let update!: () => void;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const start = vi.fn((callback: () => void) => {
    update = callback;
    if (!deferred) update();
    return { ready: Promise.resolve(), finished, skipTransition: vi.fn() };
  });
  Object.defineProperty(doc, "startViewTransition", { configurable: true, value: start });
  resets.push(() => {
    update?.();
    finish();
    if (previous) Object.defineProperty(doc, "startViewTransition", previous);
    else Reflect.deleteProperty(doc, "startViewTransition");
  });
  return { start, finish, apply: () => update() };
}

function normalMotion() {
  root.removeAttribute("data-perf-tier");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
}

afterEach(async () => {
  for (const reset of resets.splice(0)) reset();
  await Promise.resolve();
  await Promise.resolve();
  for (const frame of frames.splice(0)) frame.remove();
  root.removeAttribute("data-theme-transition");
  if (previousTier === null) root.removeAttribute("data-perf-tier");
  else root.setAttribute("data-perf-tier", previousTier);
  if (previousTheme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", previousTheme);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("independent windows release their own theme dissolve while another window is still animating", async () => {
  normalMotion();
  const child = otherDocument();
  root.setAttribute("data-theme", "light");
  child.documentElement.setAttribute("data-theme", "light");
  const first = transition(document);
  const second = transition(child);
  applyTheme(root, "dark");
  applyTheme(child.documentElement, "dark");
  first.finish();
  await waitFor(() => expect(root.hasAttribute("data-theme-transition")).toBe(false));
  expect(child.documentElement.hasAttribute("data-theme-transition")).toBe(true);
  second.finish();
  await waitFor(() => expect(child.documentElement.hasAttribute("data-theme-transition")).toBe(false));
});

it("opening a dissolve in another window does not apply this window's pending theme before its snapshot", () => {
  normalMotion();
  const child = otherDocument();
  root.setAttribute("data-theme", "light");
  child.documentElement.setAttribute("data-theme", "light");
  const first = transition(document, true);
  const second = transition(child, true);
  applyTheme(root, "dark");
  applyTheme(child.documentElement, "dark");
  expect(root.getAttribute("data-theme")).toBe("light");
  expect(child.documentElement.getAttribute("data-theme")).toBe("light");
  first.apply();
  second.apply();
  expect(root.getAttribute("data-theme")).toBe("dark");
  expect(child.documentElement.getAttribute("data-theme")).toBe("dark");
});

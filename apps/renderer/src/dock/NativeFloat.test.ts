import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mirrorAppearance } from "./NativeFloat";

const root = document.documentElement;
const names = ["data-theme", "data-density", "data-palette", "data-perf-tier", "data-backdrop", "data-backdrop-scope", "data-preview", "data-preview-marks", "data-theme-transition"];
const previous = new Map(names.map(name => [name, root.getAttribute(name)]));
const frames: HTMLIFrameElement[] = [];
const releases: (() => void)[] = [];
const finishes: (() => void)[] = [];

function childDocument() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  return frame.contentDocument!;
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const finish of finishes.splice(0)) finish();
  await Promise.resolve();
  await Promise.resolve();
  for (const frame of frames.splice(0)) frame.remove();
  for (const [name, value] of previous) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("native appearance mirrors removed preferences without copying document-local motion flags", async () => {
  root.setAttribute("data-theme", "light");
  root.setAttribute("data-palette", "tri");
  root.setAttribute("data-preview", "on");
  root.setAttribute("data-preview-marks", "off");
  root.setAttribute("data-theme-transition", "");
  const child = childDocument();
  child.documentElement.setAttribute("data-native-owner", "conversation");
  releases.push(mirrorAppearance(child));
  expect(child.documentElement.getAttribute("data-palette")).toBe("tri");
  expect(child.documentElement.getAttribute("data-preview-marks")).toBe("off");
  expect(child.documentElement.hasAttribute("data-theme-transition")).toBe(false);
  root.removeAttribute("data-palette");
  root.removeAttribute("data-theme-transition");
  await waitFor(() => expect(child.documentElement.hasAttribute("data-palette")).toBe(false));
  expect(child.documentElement.getAttribute("data-native-owner")).toBe("conversation");
});

it("a native window owns its theme dissolve and does not restart it when the main window finishes", async () => {
  root.removeAttribute("data-perf-tier");
  root.setAttribute("data-theme", "light");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const child = childDocument();
  child.documentElement.setAttribute("data-theme", "light");
  vi.spyOn(child, "visibilityState", "get").mockReturnValue("visible");
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  finishes.push(finish);
  const start = vi.fn((update: () => void) => {
    update();
    return { ready: Promise.resolve(), finished, skipTransition: vi.fn() };
  });
  Object.defineProperty(child, "startViewTransition", { configurable: true, value: start });
  releases.push(mirrorAppearance(child));
  root.setAttribute("data-theme-transition", "");
  root.setAttribute("data-theme", "dark");
  await waitFor(() => expect(child.documentElement.getAttribute("data-theme")).toBe("dark"));
  expect(start).toHaveBeenCalledOnce();
  root.removeAttribute("data-theme-transition");
  await Promise.resolve();
  expect(child.documentElement.hasAttribute("data-theme-transition")).toBe(true);
  expect(start).toHaveBeenCalledOnce();
  finish();
  await waitFor(() => expect(child.documentElement.hasAttribute("data-theme-transition")).toBe(false));
});

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { ThinkingSliderPopover } from "./ThinkingSlider";

const ITEMS = [
  { id: "off", label: "Off" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

afterEach(cleanup);

it("commits the next level from the keyboard and returns to the Runtime value when the change fails", async () => {
  let reject!: (ok: boolean) => void;
  const commit = vi.fn(() => new Promise<boolean>((resolve) => { reject = resolve; }));
  render(<I18nProvider forcedLanguage="en">
    <ThinkingSliderPopover items={ITEMS} value="low" onCommit={commit} onClose={() => {}} />
  </I18nProvider>);

  const slider = screen.getByRole("slider", { name: "Reasoning Effort" });
  expect(document.activeElement).toBe(slider);
  expect(slider.getAttribute("aria-valuetext")).toBe("Low");

  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(commit).toHaveBeenCalledWith("medium");
  // The chosen level stays under the thumb while the Runtime is asked.
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");

  await act(async () => { reject(false); });
  expect(slider.getAttribute("aria-valuetext")).toBe("Low");
});

it("jumps to a level and preserves the selection across mounted language changes", async () => {
  const commit = vi.fn(() => Promise.resolve(true));
  const popover = (language: "zh" | "en") => <I18nProvider forcedLanguage={language}>
    <ThinkingSliderPopover items={ITEMS} value="off" onCommit={commit} onClose={() => {}} />
  </I18nProvider>;
  const view = render(popover("zh"));
  fireEvent.click(screen.getByRole("button", { name: "High" }));
  await act(async () => {});
  expect(commit).toHaveBeenCalledWith("high");
  expect(screen.getByText("深入推理，适合复杂问题。")).toBeTruthy();
  const slider = screen.getByRole("slider");
  view.rerender(popover("en"));
  expect(screen.getByText("Deep reasoning for hard problems.")).toBeTruthy();
  expect(screen.getByRole("slider")).toBe(slider);
  view.rerender(popover("zh"));
  expect(slider.getAttribute("aria-valuetext")).toBe("High");
  expect(screen.getByText("深入推理，适合复杂问题。")).toBeTruthy();
});

it("sends the final queued level through the current session callback", async () => {
  let finish!: (ok: boolean) => void;
  const initial = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const current = vi.fn(async () => true);
  const popover = (commit: (id: string) => Promise<boolean>) => <I18nProvider forcedLanguage="en">
    <ThinkingSliderPopover items={ITEMS} value="low" onCommit={commit} onClose={() => {}} />
  </I18nProvider>;
  const view = render(popover(initial));
  const slider = screen.getByRole("slider");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  fireEvent.keyDown(slider, { key: "End" });
  view.rerender(popover(current));
  await act(async () => { finish(true); });
  expect(initial).toHaveBeenCalledTimes(1);
  expect(current).toHaveBeenCalledWith("high");
});

it("does not send queued changes after the owning picker is removed", async () => {
  let finish!: (ok: boolean) => void;
  const commit = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const view = render(<I18nProvider forcedLanguage="en">
    <ThinkingSliderPopover items={ITEMS} value="low" onCommit={commit} onClose={() => {}} />
  </I18nProvider>);
  const slider = screen.getByRole("slider");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  fireEvent.keyDown(slider, { key: "End" });
  view.unmount();
  await act(async () => { finish(true); });
  expect(commit).toHaveBeenCalledTimes(1);
});

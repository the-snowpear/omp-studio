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

it("jumps to a level when its notch label is clicked", () => {
  const commit = vi.fn(() => Promise.resolve(true));
  render(<I18nProvider forcedLanguage="zh">
    <ThinkingSliderPopover items={ITEMS} value="off" onCommit={commit} onClose={() => {}} />
  </I18nProvider>);
  fireEvent.click(screen.getByRole("button", { name: "High" }));
  expect(commit).toHaveBeenCalledWith("high");
  expect(screen.getByText("深入推理，适合复杂问题。")).toBeTruthy();
});

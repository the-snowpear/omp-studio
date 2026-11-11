import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { OnboardingHost, ONBOARDING_STEPS } from "./OnboardingTour";
import {
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_TOUR_ID,
  __resetOnboardingForTests,
  __setOnboardingAutoOpenForTests,
  openOnboardingTour,
} from "./onboardingState";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "../settings/startupNotice";

function mount() {
  return render(<I18nProvider forcedLanguage="en"><OnboardingHost /></I18nProvider>);
}

const closeButton = () => screen.queryByRole("button", { name: "Close tutorial" });

describe("workbench onboarding tour", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
    __resetOnboardingForTests();
    __setOnboardingAutoOpenForTests(true);
  });
  afterEach(() => {
    cleanup();
    __setOnboardingAutoOpenForTests(false);
    __resetOnboardingForTests();
  });

  it("first run cannot be dismissed until every step has been shown", async () => {
    mount();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(closeButton()).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();

    const next = () => screen.getByRole("button", { name: /^Next/ });
    for (let step = 1; step < ONBOARDING_STEPS.length; step += 1) {
      expect(closeButton()).toBeNull();
      fireEvent.click(next());
    }
    expect(closeButton()).toBeTruthy();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe(ONBOARDING_TOUR_ID);
  });

  it("does not open again once completed, and Help reopens it as closable at any step", async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => openOnboardingTour());
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(closeButton()).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the startup notice only after the first-run tour is finished", async () => {
    localStorage.removeItem(STARTUP_NOTICE_STORAGE_KEY);
    mount();
    await screen.findByRole("dialog");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    for (let step = 1; step < ONBOARDING_STEPS.length; step += 1) {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    }
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBe("startupNoticeTitle");
  });
});

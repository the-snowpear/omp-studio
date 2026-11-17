import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StudioClientImpl } from "@omp-studio/client";
import { createContractFixtureApi } from "@omp-studio/testkit";
import { App } from "../App";
import "../SettingsPage";
import { __resetAppSettingsForTests, updateAppSettings } from "../settings/appSettings";
import { setModelConfigDirty } from "../models/modelConfigState";
import { STARTUP_NOTICE_ID, STARTUP_NOTICE_STORAGE_KEY } from "../settings/startupNotice";
import { ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID } from "../onboarding/onboardingState";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { applyTheme } from "../themeTransition";
import {
  WEBSITE_EMBED_SOURCE,
  parseEmbedInboundMessage,
  requestEmbedRoute,
  setExpectedHostTheme,
} from "./websiteEmbed";

vi.mock("../TerminalPane", () => ({ TerminalPane: () => null }));

const clients: StudioClientImpl[] = [];
const originalParentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");

afterEach(async () => {
  cleanup();
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalParentDescriptor) {
    Object.defineProperty(window, "parent", originalParentDescriptor);
  }
  delete document.documentElement.dataset.embed;
  document.documentElement.removeAttribute("data-theme");
  setExpectedHostTheme(null);
  setModelConfigDirty(false);
  localStorage.clear();
  __resetAppSettingsForTests(null);
  window.history.replaceState(null, "", "/");
});

it("parses valid inbound embed messages and ignores untrusted shapes", () => {
  expect(parseEmbedInboundMessage({ source: WEBSITE_EMBED_SOURCE, type: "set-route", route: "history" })).toEqual({
    source: WEBSITE_EMBED_SOURCE,
    type: "set-route",
    route: "history",
  });
  expect(parseEmbedInboundMessage({ source: WEBSITE_EMBED_SOURCE, type: "set-theme", theme: "dark" })).toEqual({
    source: WEBSITE_EMBED_SOURCE,
    type: "set-theme",
    theme: "dark",
  });
  expect(parseEmbedInboundMessage({ source: "other", type: "set-route", route: "home" })).toBeNull();
  expect(parseEmbedInboundMessage({ source: WEBSITE_EMBED_SOURCE, type: "set-route", route: "unknown" })).toBeNull();
  expect(parseEmbedInboundMessage({ source: WEBSITE_EMBED_SOURCE, type: "set-theme", theme: "blue" })).toBeNull();
});

it("applies theme synchronously without View Transition in embed mode", () => {
  document.documentElement.dataset.embed = "1";
  document.documentElement.setAttribute("data-theme", "light");
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const start = vi.fn();
  const previous = Object.getOwnPropertyDescriptor(document, "startViewTransition");
  Object.defineProperty(document, "startViewTransition", { configurable: true, value: start });
  try {
    applyTheme(document.documentElement, "dark");
    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  } finally {
    if (previous) Object.defineProperty(document, "startViewTransition", previous);
    else Reflect.deleteProperty(document, "startViewTransition");
  }
});

it("keeps full shell chrome without preview-switch, switches routes without echo or confirm, and reports internal navigation", async () => {
  document.documentElement.dataset.embed = "1";
  document.documentElement.setAttribute("data-theme", "light");
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  localStorage.setItem("omp.lastRoute", "home");
  __resetAppSettingsForTests(JSON.stringify({
    language: "en",
    theme: "light",
    startupPage: "last",
    restoreLastProject: true,
    rememberLayout: false,
  }));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();

  const postMessage = vi.fn();
  Object.defineProperty(window, "parent", { configurable: true, value: { postMessage } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

  const client = new StudioClientImpl(createContractFixtureApi());
  clients.push(client);
  render(<App client={client} />);

  await waitFor(() => expect(document.querySelector('#pageBody[data-route="home"]')).not.toBeNull());
  expect(document.querySelector(".app-titlebar")).not.toBeNull();
  expect(document.querySelector(".app-rail")).not.toBeNull();
  expect(document.querySelector("#pageHead")).not.toBeNull();
  expect(document.querySelector(".preview-switch")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();

  // Host route transition updates active page without echoing `route-changed` or prompting confirm.
  setModelConfigDirty(true);
  act(() => { requestEmbedRoute("history"); });
  await waitFor(() => expect(document.querySelector('#pageBody[data-route="history"]')).not.toBeNull());
  expect(confirm).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "route-changed" }), expect.anything());

  // Clicking a `#pageHead` `.page-nav` tab switches routes without confirm and emits `route-changed`.
  setModelConfigDirty(true);
  const capTab = document.querySelector('#pageHead nav.page-nav a[data-nav="capabilities"]')!;
  fireEvent.click(capTab);
  await waitFor(() => expect(document.querySelector('#pageBody[data-route="capabilities"]')).not.toBeNull());
  expect(confirm).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({ source: WEBSITE_EMBED_SOURCE, type: "route-changed", route: "capabilities" }, expect.any(String));

  // Clicking `AppNavRail` switches routes and emits `route-changed`.
  postMessage.mockClear();
  fireEvent.click(document.querySelector('.app-rail button[aria-label="Home"]')!);
  await waitFor(() => expect(document.querySelector('#pageBody[data-route="home"]')).not.toBeNull());
  expect(postMessage).toHaveBeenCalledWith({ source: WEBSITE_EMBED_SOURCE, type: "route-changed", route: "home" }, expect.any(String));

  // Clicking `#pageHead` theme toggle updates theme synchronously and emits `theme-changed`.
  postMessage.mockClear();
  fireEvent.click(document.querySelector('#pageHead button[data-tip*="theme" i]')!);
  await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  expect(postMessage).toHaveBeenCalledWith({ source: WEBSITE_EMBED_SOURCE, type: "theme-changed", theme: "dark" }, expect.any(String));

  // Internal UI transition to `statistics` emits `route-changed`.
  postMessage.mockClear();
  const statsButton = await screen.findByRole("button", { name: /^Statistics$/i });
  fireEvent.click(statsButton);
  await waitFor(() => expect(document.querySelector('#pageBody[data-route="statistics"]')).not.toBeNull());
  expect(postMessage).toHaveBeenCalledWith({ source: WEBSITE_EMBED_SOURCE, type: "route-changed", route: "statistics" }, expect.any(String));
});

it("forwards SettingsPage theme changes through AppShell and emits theme-changed", async () => {
  document.documentElement.dataset.embed = "1";
  document.documentElement.setAttribute("data-theme", "light");
  localStorage.setItem(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
  localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  localStorage.setItem("omp.lastRoute", "settings");
  __resetAppSettingsForTests(JSON.stringify({
    language: "en",
    theme: "light",
    startupPage: "last",
    restoreLastProject: true,
    rememberLayout: false,
  }));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.history.replaceState(null, "", "?preview=1&marks=off&embed=1");

  const postMessage = vi.fn();
  Object.defineProperty(window, "parent", { configurable: true, value: { postMessage } });

  const client = new StudioClientImpl(createContractFixtureApi());
  clients.push(client);
  render(<App client={client} />);

  await waitFor(() => expect(document.querySelector('#pageBody[data-route="settings"]')).not.toBeNull());
  fireEvent.click(await screen.findByRole("tab", { name: /Appearance/i }, { timeout: 5000 }));
  const themeTrigger = await screen.findByRole("combobox", { name: /Theme/i });
  fireEvent.click(themeTrigger);
  const darkOption = await screen.findByRole("option", { name: /Dark/i });
  fireEvent.click(darkOption);

  await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  expect(postMessage).toHaveBeenCalledWith({ source: WEBSITE_EMBED_SOURCE, type: "theme-changed", theme: "dark" }, expect.any(String));

  // Host theme sync marks expected theme so theme-changed is not echoed back.
  postMessage.mockClear();
  setExpectedHostTheme("light");
  act(() => { updateAppSettings({ theme: "light" }); });
  await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
  expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "theme-changed" }), expect.anything());
});

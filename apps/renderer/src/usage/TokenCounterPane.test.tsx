import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { DockPanel, DockProvider, DockSlot, useDock } from "../dock/DockContext";
import { locatePanel } from "../dock/model";
import { DockStore } from "../dock/store";
import { I18nProvider } from "../i18n";
import { WORKBENCH_PANELS } from "../panels/registry";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_TOKEN_COUNT } from "../preview/tokenCounterPreview";
import { waitReceipt } from "../hostError";
import { TokenCounterPane } from "./TokenCounterPane";

vi.mock("../hostError", async original => ({ ...await original<typeof import("../hostError")>(), waitReceipt: vi.fn() }));
afterEach(() => {
  cleanup(); window.dispatchEvent(new Event("pagehide")); vi.restoreAllMocks(); vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/"); localStorage.clear();
});

it("counts real input through Runtime and clears old results when edited", async () => {
  const command = vi.fn().mockResolvedValue({ requestId: "count" });
  vi.mocked(waitReceipt).mockResolvedValue({ result: PREVIEW_TOKEN_COUNT });
  render(<I18nProvider forcedLanguage="zh"><TokenCounterPane client={{ command } as unknown as StudioClient} /></I18nProvider>);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Count this text" } });
  fireEvent.click(screen.getByRole("button", { name: "计算 Token" }));
  await waitFor(() => expect(screen.getByText("o200k_base")).toBeTruthy());
  expect(command).toHaveBeenCalledWith("tokens.count", { text: "Count this text" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated text" } });
  expect(screen.queryByText("o200k_base")).toBeNull();
});

it("retains preview input and results across docking, hiding and restoring", async () => {
  window.history.replaceState(null, "", "/?preview=1&marks=off");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 450));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 400, 450)] as unknown as DOMRectList);
  const store = new DockStore(null);
  const command = vi.fn();
  store.dispatch({ type: "open", panel: "token-counter" });
  expect(locatePanel(store.getSnapshot().layout, "token-counter")?.region).toBe("float");
  function Surface() {
    const { layout } = useDock();
    const location = locatePanel(layout, "token-counter");
    return <><div className="adaptive-workbench"><div key={location?.region ?? "hidden"}>{location ? <DockSlot id="token-counter" /> : null}</div></div><DockPanel id="token-counter"><TokenCounterPane client={{ command } as unknown as StudioClient} /></DockPanel></>;
  }
  render(<PreviewModeProvider><I18nProvider forcedLanguage="zh"><DockProvider definitions={WORKBENCH_PANELS} store={store}><Surface /></DockProvider></I18nProvider></PreviewModeProvider>);
  const input = await screen.findByRole("textbox");
  fireEvent.change(input, { target: { value: "Keep my text" } });
  fireEvent.click(screen.getByRole("button", { name: "计算 Token" }));
  expect(screen.getByText("o200k_base")).toBeTruthy();
  expect(screen.queryByText(/演示/)).toBeNull();
  expect(command).not.toHaveBeenCalled();
  for (const region of ["left", "rail", "right", "bottom", "float"] as const) {
    act(() => store.dispatch({ type: "move", panels: ["token-counter"], target: { region } }));
    expect(document.querySelector('[aria-label="待计数文本"]')).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe("Keep my text");
    expect(screen.getByText("o200k_base")).toBeTruthy();
  }
  act(() => store.dispatch({ type: "hide", panels: ["token-counter"] }));
  act(() => store.dispatch({ type: "open", panel: "token-counter" }));
  expect(document.querySelector('[aria-label="待计数文本"]')).toBe(input);
  expect(screen.getByText("o200k_base")).toBeTruthy();
});

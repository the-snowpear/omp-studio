import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { MediaPage } from "./MediaPage";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { setMediaIntent } from "./media/MediaWorkbench";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function open() {
  const client = {
    command: vi.fn(),
    query: vi.fn(),
  } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <MediaPage client={client} />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  return client;
}

it("keeps a generation draft while switching workspaces and does not call Host for preview actions", () => {
  const client = open();
  fireEvent.change(screen.getByLabelText("提示词"), {
    target: { value: "Keep this image draft" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "语音" }));
  expect(
    screen.getByRole("tab", { name: "转写音频" }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "产物库" }));
  expect(
    screen.getByRole("button", { name: /workspace-preview.png/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "生成" }));
  expect(screen.getByDisplayValue("Keep this image draft")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
  expect(client.query).not.toHaveBeenCalled();
});

it("routes a transcription shortcut to voice and releases the Live surface when leaving it", () => {
  setMediaIntent("transcription");
  open();
  expect(
    screen.getByRole("tab", { name: "语音" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByRole("region", { name: "Live 实时语音" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Live" }));
  expect(screen.getByRole("region", { name: "Live 实时语音" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "生成" }));
  expect(screen.queryByRole("region", { name: "Live 实时语音" })).toBeNull();
});

it("releases library media when hidden while keeping the selected artifact and filter", () => {
  open();
  fireEvent.click(screen.getByRole("tab", { name: "产物库" }));
  fireEvent.change(screen.getByRole("combobox", { name: "文件类型" }), {
    target: { value: "audio" },
  });
  fireEvent.click(screen.getByRole("button", { name: /review-notes.wav/ }));
  expect(document.querySelector(".media-inspector audio")).not.toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "生成" }));
  expect(document.querySelector(".media-inspector audio")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "产物库" }));
  expect(document.querySelector(".media-inspector audio")).not.toBeNull();
  expect(
    (screen.getByRole("combobox", { name: "文件类型" }) as HTMLSelectElement)
      .value,
  ).toBe("audio");
});

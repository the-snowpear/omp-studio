import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { RuntimeQueueBar } from "./RuntimeQueueBar";
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("edits submitted preview entries locally and prevents changing in-flight input", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <RuntimeQueueBar
          client={client}
          available={false}
          pending={0}
          running={false}
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /已提交\s*4/ }));
  const row = within(screen.getByText("检查截图中的布局问题").closest(".runtime-queue-row") as HTMLElement);
  const compaction = within(screen.getByText("压缩上下文 / Compact context").closest(".runtime-queue-row") as HTMLElement);
  const inFlight = within(screen.getByText("先保留当前改动，补充验收说明").closest(".runtime-queue-row") as HTMLElement);
  expect((compaction.getByRole("button", { name: "提升为纠偏" }) as HTMLButtonElement).disabled).toBe(true);
  expect((inFlight.getByRole("button", { name: "编辑已提交消息" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(row.getByRole("button", { name: "编辑已提交消息" }));
  fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), {
    target: { value: "修改后的截图说明" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存编辑" }));
  await screen.findByText("修改后的截图说明");
  expect(screen.getByText("1 张图片")).toBeTruthy();
  expect(client.command).not.toHaveBeenCalled();
  fireEvent.click(row.getByRole("button", { name: "提升为纠偏" }));
  await waitFor(() =>
    expect(
      (
        row.getByRole("button", {
          name: "提升为纠偏",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true),
  );
});
it("does not send new queue operations to an old Runtime", () => {
  const client = { command: vi.fn() } as unknown as StudioClient;
  render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <RuntimeQueueBar
          client={client}
          sessionId="s"
          available
          pending={2}
          running
        />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(screen.queryByRole("group")).toBeNull();
  expect(client.command).not.toHaveBeenCalled();
});

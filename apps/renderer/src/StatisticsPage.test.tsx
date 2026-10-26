import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { StatisticsPage } from "./StatisticsPage";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function clientReturning(dashboard: { available: boolean; url?: string; reason?: string }) {
  return {
    query: vi.fn(async (name: string) => {
      if (name === "stats.dashboard") return dashboard;
      throw new Error(`unexpected query ${name}`);
    }),
    command: vi.fn(),
    subscribe: vi.fn(),
  } as unknown as StudioClient;
}

it("embeds the loopback dashboard the Host reports", async () => {
  const client = clientReturning({ available: true, url: "http://127.0.0.1:3847/#/overview?range=all" });
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <StatisticsPage client={client} />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
  const frame = container.querySelector("iframe");
  expect(frame?.getAttribute("src")).toBe("http://127.0.0.1:3847/#/overview?range=all");
  expect(frame?.getAttribute("title")).toBe("OMP 统计面板");
});

it("states the reason and renders no frame when no panel answered", async () => {
  const client = clientReturning({ available: false, reason: "未找到 OMP Runtime，无法启动本机统计面板。" });
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <StatisticsPage client={client} />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  expect(await screen.findByText("未找到 OMP Runtime，无法启动本机统计面板。")).toBeTruthy();
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});

it("preview never fabricates an embed and never reaches the Host", async () => {
  localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
  const client = clientReturning({ available: true, url: "http://127.0.0.1:3847/#/overview?range=all" });
  const { container } = render(
    <I18nProvider forcedLanguage="zh">
      <PreviewModeProvider switchEnabled>
        <StatisticsPage client={client} />
      </PreviewModeProvider>
    </I18nProvider>,
  );
  // An iframe here would claim a local service exists that preview never started.
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByText(/需关闭预览后查看/)).toBeTruthy();
  expect(client.query).not.toHaveBeenCalled();
  expect(client.command).not.toHaveBeenCalled();
});

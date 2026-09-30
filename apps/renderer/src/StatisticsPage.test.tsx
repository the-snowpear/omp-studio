import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "./i18n";
import { PreviewModeProvider } from "./preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "./preview/mode";
import { StatisticsPage } from "./StatisticsPage";
afterEach(()=>{cleanup();localStorage.clear();});
it("preview statistics preserves unknown pricing and Frustration requires review without Host calls",async()=>{
 localStorage.setItem(PREVIEW_MODE_STORAGE_KEY,"1");const client={query:vi.fn(),command:vi.fn()} as unknown as StudioClient;
 render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><StatisticsPage client={client}/></PreviewModeProvider></I18nProvider>);
 fireEvent.click(screen.getByRole("tab",{name:"模型与提供商"}));expect(screen.getByText("未知")).toBeTruthy();
 fireEvent.click(screen.getByRole("tab",{name:"项目与会话"}));expect(screen.getByText("demo-session-swift.jsonl")).toBeTruthy();expect(screen.getAllByText("—").length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole("tab",{name:"Frustration"}));expect(screen.queryByRole("alertdialog")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"估算分析范围与费用"}));expect(await screen.findByRole("alertdialog")).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"确认并分析"}));expect(client.command).not.toHaveBeenCalled();expect(client.query).not.toHaveBeenCalled();
});

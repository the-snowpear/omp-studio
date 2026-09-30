import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { PredictionSettings } from "./PredictionSettings";
afterEach(()=>{cleanup();localStorage.clear();});
it("preview import and downloads require confirmation and never call Host",async()=>{
 localStorage.setItem(PREVIEW_MODE_STORAGE_KEY,"1");const command=vi.fn();render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><PredictionSettings client={{command} as unknown as StudioClient} sessionId={undefined} available={false}/></PreviewModeProvider></I18nProvider>);
 const details=screen.getByText(/输入预测语料与模型/).closest("details")!;details.open=true;fireEvent(details,new Event("toggle"));
 fireEvent.click(await screen.findByRole("button",{name:"导入外部历史"}));expect(screen.getByRole("alertdialog")).toBeTruthy();expect(command).not.toHaveBeenCalled();fireEvent.click(screen.getByRole("button",{name:"确认"}));
 fireEvent.click(await screen.findByRole("button",{name:"下载 SmolLM2"}));expect(screen.getByRole("alertdialog").textContent).toContain("147 MB");fireEvent.click(screen.getByRole("button",{name:"确认"}));expect(command).not.toHaveBeenCalled();
});

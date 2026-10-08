import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { ServiceTierPicker } from "./ServiceTierPicker";
afterEach(()=>{cleanup();localStorage.clear();});
it("preview tier choices stay local and retain unsupported choices",()=>{
 localStorage.setItem(PREVIEW_MODE_STORAGE_KEY,"1");const command=vi.fn();render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><ServiceTierPicker client={{command} as unknown as StudioClient} sessionId={undefined} available={false} modelKey="demo"/></PreviewModeProvider></I18nProvider>);
 fireEvent.click(screen.getByRole("button",{name:"服务档位"}));expect((screen.getByRole("button",{name:"Ultrafast"}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole("button",{name:"Priority"}));expect(command).not.toHaveBeenCalled();
});

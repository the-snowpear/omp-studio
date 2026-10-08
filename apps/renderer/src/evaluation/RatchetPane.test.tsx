import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { RatchetPane } from "./RatchetPane";
afterEach(()=>{cleanup();localStorage.clear();});
it("Ratchet preview requires all stage approvals, supports start and stop, and never writes to Runtime",async()=>{
 localStorage.setItem(PREVIEW_MODE_STORAGE_KEY,"1");const client={command:vi.fn(),query:vi.fn()} as unknown as StudioClient;
 render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><RatchetPane client={client} available/></PreviewModeProvider></I18nProvider>);
 const start=await screen.findByRole("button",{name:"启动迭代"});expect(start.hasAttribute("disabled")).toBe(true);
 fireEvent.click(screen.getAllByRole("button",{name:"检查与审批"})[2]!);fireEvent.click(screen.getByRole("button",{name:"继续"}));await waitFor(()=>expect(start.hasAttribute("disabled")).toBe(false));
 fireEvent.click(start);fireEvent.click(screen.getByRole("button",{name:"继续"}));await waitFor(()=>expect(screen.getByRole("button",{name:"停止后续工作"}).hasAttribute("disabled")).toBe(false));
 fireEvent.click(screen.getByRole("button",{name:"停止后续工作"}));expect(client.command).not.toHaveBeenCalled();expect(client.query).not.toHaveBeenCalled();
});
it("old Runtime is capability gated before any Ratchet command",()=>{
 const client={command:vi.fn(),query:vi.fn()} as unknown as StudioClient;
 render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><RatchetPane client={client} sessionId="s" available capabilities={{capabilities:[]} as never}/></PreviewModeProvider></I18nProvider>);
 expect(screen.getByText("此 Runtime 尚不支持 Ratchet")).toBeTruthy();expect(screen.getByRole("button",{name:"新建流程"}).hasAttribute("disabled")).toBe(true);expect(client.command).not.toHaveBeenCalled();
});

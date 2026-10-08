import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { StudioClient } from "@omp-studio/client-contract";
import type { StudioSpeed } from "@omp-studio/studio-protocol";
import { I18nProvider } from "../i18n";
import { PreviewModeProvider } from "../preview/PreviewContext";
import { PREVIEW_MODE_STORAGE_KEY } from "../preview/mode";
import { ComposerSpeedControl } from "./ComposerSpeedControl";
afterEach(() => { cleanup(); localStorage.clear(); });
it("preview exposes supported speeds and preserves its selection when the menu reopens without a native write", async () => {
 localStorage.setItem(PREVIEW_MODE_STORAGE_KEY, "1");
 const client = { command: vi.fn() } as unknown as StudioClient;
 function Harness() {
  const [selected, setSelected] = useState<StudioSpeed>("normal"); const [shown, setShown] = useState(true);
  return <><button onClick={() => setShown(value => !value)}>Toggle menu</button>{shown ? <ComposerSpeedControl client={client} available={false} previewSelected={selected} onPreviewChange={setSelected}/> : null}</>;
 }
 render(<I18nProvider forcedLanguage="zh"><PreviewModeProvider switchEnabled><Harness/></PreviewModeProvider></I18nProvider>);
 const select = await screen.findByRole("combobox", { name: "服务档位" });
 expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["Normal", "Fast", "Ultrafast", "Slow"]);
 fireEvent.change(select, { target: { value: "ultrafast" } }); expect((select as HTMLSelectElement).value).toBe("ultrafast");
 fireEvent.click(screen.getByRole("button", { name: "Toggle menu" })); fireEvent.click(screen.getByRole("button", { name: "Toggle menu" }));
 expect((await screen.findByRole("combobox", { name: "服务档位" }) as HTMLSelectElement).value).toBe("ultrafast"); expect(client.command).not.toHaveBeenCalled();
});

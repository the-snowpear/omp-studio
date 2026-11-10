import type { WebContents } from "electron";

/** Windows' custom menu has no Electron DevTools accelerator. Development only. */
export function installDevelopmentTools(contents: WebContents, enabled: boolean): void {
  if (!enabled) return;
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const f12 = input.key === "F12" && !input.control && !input.shift && !input.alt && !input.meta;
    const inspect = input.key.toLowerCase() === "i" && input.control && input.shift && !input.alt && !input.meta;
    if (!f12 && !inspect) return;
    event.preventDefault();
    if (contents.isDevToolsOpened()) contents.closeDevTools();
    else contents.openDevTools({ mode: "detach", activate: true });
  });
}

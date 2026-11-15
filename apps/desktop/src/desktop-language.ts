/**
 * Main-process IPC handler for syncing the active desktop UI language from Renderer.
 * Must only be imported in Electron Main (`main.ts`).
 */
import { ipcMain, type WebContents } from "electron";
import { DESKTOP_LANGUAGE_CHANNEL, parseDesktopLanguagePayload, setDesktopLanguage } from "./desktop-language-shared.js";

export * from "./desktop-language-shared.js";

export function registerDesktopLanguageIpc(options: {
  readonly isTrustedSender: (sender: Pick<WebContents, "isDestroyed" | "getURL">) => boolean;
}): () => void {
  ipcMain.removeHandler(DESKTOP_LANGUAGE_CHANNEL);
  ipcMain.handle(DESKTOP_LANGUAGE_CHANNEL, (event, rawPayload: unknown) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return;
    const next = parseDesktopLanguagePayload(rawPayload);
    if (next !== undefined) setDesktopLanguage(next);
  });
  return () => {
    ipcMain.removeHandler(DESKTOP_LANGUAGE_CHANNEL);
  };
}

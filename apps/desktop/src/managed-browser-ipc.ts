import type { IpcMain, WebContents } from "electron";
import type { ManagedBrowserCommand, ManagedBrowserPresentation } from "@omp-studio/studio-protocol";
import type { DesktopManagedBrowser } from "./managed-browser.js";
import { MANAGED_BROWSER_CHANNELS as CHANNELS } from "./managed-browser-shared.js";

export function registerManagedBrowserIpc(options: { ipcMain: IpcMain; manager: DesktopManagedBrowser; isTrustedSender(sender: WebContents): boolean; isLocal(): boolean }) {
  const senders = new Set<WebContents>();
  const trusted = (sender: WebContents) => {
    if (sender.isDestroyed() || !options.isTrustedSender(sender) || !options.isLocal()) throw new Error("Managed browser is available to the local desktop only.");
    if (!senders.has(sender)) { senders.add(sender); sender.once("destroyed", () => senders.delete(sender)); }
  };
  options.ipcMain.handle(CHANNELS.available, event => !event.sender.isDestroyed() && options.isTrustedSender(event.sender) && options.isLocal());
  options.ipcMain.handle(CHANNELS.read, (event, sessionId: string) => { trusted(event.sender); if (typeof sessionId !== "string" || !sessionId) throw new Error("Select a chat first."); return options.manager.read(sessionId); });
  options.ipcMain.handle(CHANNELS.execute, (event, command: ManagedBrowserCommand) => { trusted(event.sender); if (!command || typeof command.sessionId !== "string" || typeof command.action !== "string") throw new Error("Invalid browser request."); return options.manager.execute(command); });
  options.ipcMain.handle(CHANNELS.present, (event, presentation: ManagedBrowserPresentation) => { trusted(event.sender); if (!presentation || typeof presentation.surfaceId !== "string" || typeof presentation.sessionId !== "string") throw new Error("Invalid browser presentation."); return options.manager.present(presentation); });
  const unsubscribe = options.manager.subscribe(event => { for (const sender of senders) if (!sender.isDestroyed() && options.isTrustedSender(sender) && options.isLocal()) sender.send(CHANNELS.event, event); });
  return { dispose() { unsubscribe(); senders.clear(); for (const channel of [CHANNELS.available, CHANNELS.read, CHANNELS.execute, CHANNELS.present]) options.ipcMain.removeHandler(channel); } };
}

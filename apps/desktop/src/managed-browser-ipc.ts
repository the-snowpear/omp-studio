import { BrowserWindow, type IpcMain, type WebContents } from "electron";
import type { ManagedBrowserCommand, ManagedBrowserInspectionRequest, ManagedBrowserPresentation } from "@omp-studio/studio-protocol";
import type { DesktopManagedBrowser } from "./managed-browser.js";
import { MANAGED_BROWSER_CHANNELS as CHANNELS } from "./managed-browser-shared.js";

export function registerManagedBrowserIpc(options: { ipcMain: IpcMain; manager: DesktopManagedBrowser; isTrustedSender(sender: WebContents): boolean; isLocal(): boolean }) {
  const senders = new Set<WebContents>();
  const windowStops = new Map<WebContents, () => void>();
  const trusted = (sender: WebContents) => {
    if (sender.isDestroyed() || !options.isTrustedSender(sender) || !options.isLocal()) throw new Error("Managed browser is available to the local desktop only.");
    if (!senders.has(sender)) {
      senders.add(sender);
      const window = BrowserWindow.fromWebContents(sender), release = () => options.manager.releaseInspectionWindow(String(sender.id));
      const stop = () => { release(); window?.removeListener("hide", release); window?.removeListener("minimize", release); sender.removeListener("destroyed", stop); sender.removeListener("did-navigate", stop); senders.delete(sender); windowStops.delete(sender); };
      window?.on("hide", release); window?.on("minimize", release); sender.once("destroyed", stop); sender.once("did-navigate", stop); windowStops.set(sender, stop);
    }
  };
  options.ipcMain.handle(CHANNELS.available, event => !event.sender.isDestroyed() && options.isTrustedSender(event.sender) && options.isLocal());
  options.ipcMain.handle(CHANNELS.read, (event, sessionId: string) => { trusted(event.sender); if (typeof sessionId !== "string" || !sessionId) throw new Error("Select a chat first."); return options.manager.read(sessionId); });
  options.ipcMain.handle(CHANNELS.execute, (event, command: ManagedBrowserCommand) => { trusted(event.sender); if (!command || typeof command.sessionId !== "string" || typeof command.action !== "string") throw new Error("Invalid browser request."); return options.manager.execute(command); });
  options.ipcMain.handle(CHANNELS.present, (event, presentation: ManagedBrowserPresentation) => { trusted(event.sender); if (!presentation || typeof presentation.surfaceId !== "string" || typeof presentation.sessionId !== "string") throw new Error("Invalid browser presentation."); return options.manager.present(presentation); });
  options.ipcMain.handle(CHANNELS.inspect, (event, request: ManagedBrowserInspectionRequest) => { trusted(event.sender); if (!request || typeof request.sessionId !== "string" || typeof request.pageId !== "string" || typeof request.view !== "string" || typeof request.visible !== "boolean") throw new Error("Invalid browser inspection envelope."); return options.manager.inspect(request, String(event.sender.id)); });
  const unsubscribe = options.manager.subscribe(event => { for (const sender of senders) if (!sender.isDestroyed() && options.isTrustedSender(sender) && options.isLocal()) sender.send(CHANNELS.event, event); });
  return { dispose() { unsubscribe(); for (const stop of windowStops.values()) stop(); windowStops.clear(); senders.clear(); for (const channel of [CHANNELS.available, CHANNELS.read, CHANNELS.execute, CHANNELS.present, CHANNELS.inspect]) options.ipcMain.removeHandler(channel); } };
}

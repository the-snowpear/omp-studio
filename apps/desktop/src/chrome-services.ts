import type { ChromeImageIpcMain, ChromeImageSender } from "./chrome-image.js";
import { ServiceDefinitionStore, validateDefinitionInput } from "./service-definitions.js";
import { CHROME_SERVICE_CHANNELS, type ServiceDefinitionResult } from "./chrome-services-shared.js";

export function registerServiceDefinitionsIpc(options: {
  ipcMain: ChromeImageIpcMain;
  isTrustedSender(sender: ChromeImageSender): boolean;
  store: ServiceDefinitionStore;
}): { dispose(): void } {
  for (const action of ["list", "save", "remove"] as const) {
    options.ipcMain.handle(CHROME_SERVICE_CHANNELS[action], async (event, input): Promise<ServiceDefinitionResult> => {
      if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) throw new Error("Untrusted service configuration request");
      try {
        validateDefinitionInput(input, action);
        if (action === "save") await options.store.save(input);
        if (action === "remove") await options.store.remove(input);
        return { ok: true, definitions: await options.store.list(input.workspaceId) };
      } catch { return { ok: false, message: "Cannot access service configurations. Refresh and check secure local storage." }; }
    });
  }
  return { dispose: () => Object.values(CHROME_SERVICE_CHANNELS).forEach(channel => options.ipcMain.removeHandler(channel)) };
}

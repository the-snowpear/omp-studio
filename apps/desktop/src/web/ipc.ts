import { dialog, ipcMain, type WebContents } from "electron";
import { writeFile } from "node:fs/promises";
import type { SharedHostConnection } from "./client.js";
import { WEB_ACCESS_CHANNEL, WEB_CONTROL_CHANNEL } from "./shared.js";

export function registerWebAccessIpc(options: {
  connection(): Promise<SharedHostConnection>;
  isTrustedSender(sender: WebContents): boolean;
}) {
  const tracked = new Map<WebContents, () => void>();
  ipcMain.handle(
    WEB_ACCESS_CHANNEL,
    async ({ sender }, action: string, input?: any) => {
      if (!options.isTrustedSender(sender)) throw new Error("Untrusted sender");
      const connection = await options.connection();
      if (!tracked.has(sender)) {
        const off = connection.onEvent((event) => {
          if (event.kind === "control.changed" && !sender.isDestroyed())
            sender.send(WEB_CONTROL_CHANNEL, {
              ...event.control,
              deviceId: connection.id,
            });
        });
        tracked.set(sender, off);
        sender.once("destroyed", () => {
          off();
          tracked.delete(sender);
        });
      }
      switch (action) {
        case "status":
          return {
            ...(await connection.call<object>("status")),
            deviceId: connection.id,
          };
        case "take":
          return {
            ...(await connection.takeControl()),
            deviceId: connection.id,
          };
        case "pair":
          return connection.call("web.pair");
        case "revoke":
          return connection.call("web.revoke", input);
        case "rename":
          return connection.call("web.rename", input);
        case "listen":
          return connection.call("web.listen", input);
        case "certificate": {
          const value = await connection.call<string | undefined>(
            "web.certificate",
          );
          if (!value) throw new Error("Enable LAN access first");
          const destination = await dialog.showSaveDialog({
            defaultPath: "OMP-Studio-CA.cer",
          });
          if (destination.canceled || !destination.filePath) return false;
          await writeFile(destination.filePath, Buffer.from(value, "base64"));
          return true;
        }
        default:
          throw new Error("Unknown Web access action");
      }
    },
  );
  return {
    dispose() {
      ipcMain.removeHandler(WEB_ACCESS_CHANNEL);
      for (const off of tracked.values()) off();
      tracked.clear();
    },
  };
}

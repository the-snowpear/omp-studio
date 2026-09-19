import { CHROME_UPDATES_CHANNELS as C, type UpdateCheckResult } from "./chrome-updates-shared.js";
import type { ChromeUpdatesIpcOptions } from "./chrome-updates.js";
import type { UpdateCoordinator } from "./update-coordinator.js";

export function registerUnifiedUpdatesIpc(options: Pick<ChromeUpdatesIpcOptions, "ipcMain" | "isTrustedSender">, coordinator: UpdateCoordinator): () => void {
  const channels = [C.snapshot, C.prepare, C.check, C.apply, C.cancel, C.rollback, C.startApp, C.startRuntime];
  for (const channel of channels) options.ipcMain.removeHandler(channel);
  const bind = (channel: string, action: (value: unknown) => unknown) => options.ipcMain.handle(channel, (event, value) => {
    if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) throw new Error("Untrusted sender");
    return action(value);
  });
  bind(C.snapshot, () => coordinator.state);
  bind(C.prepare, async (value) => {
    if (value !== "app" && value !== "runtime" && value !== "all") throw new Error("Invalid update target");
    await coordinator.prepare(value); return coordinator.state;
  });
  bind(C.check, async (): Promise<UpdateCheckResult> => {
    const s = await coordinator.check();
    return {
      checkedAt: new Date().toISOString(),
      app: { currentVersion: s.app.currentVersion, plan: s.app.version ? "full" : "none", version: s.app.version, reason: "restart-update", sizeBytes: s.app.totalBytes, releaseNotesUrl: s.releaseNotesUrl },
      runtime: { plan: s.runtime.version ? "available" : "none", runtimeVersion: s.runtime.version, sizeBytes: s.runtime.totalBytes },
      ...(s.error ? { error: s.error } : {}),
    };
  });
  bind(C.apply, () => coordinator.apply());
  bind(C.rollback, () => coordinator.rollbackDesktop());
  // Retired online endpoints must not run a second independent updater.
  bind(C.startApp, () => ({ ok: false, message: "请使用统一更新入口" }));
  bind(C.startRuntime, () => ({ ok: false, message: "请使用统一更新入口" }));
  bind(C.cancel, () => coordinator.cancel());
  return () => { for (const channel of channels) options.ipcMain.removeHandler(channel); };
}

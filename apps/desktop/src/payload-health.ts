import { PAYLOAD_HEALTH_CHANNEL } from "./payload-health-shared.js";

interface HealthSender {
  isDestroyed(): boolean;
  getURL(): string;
}

/** A successful Host response is not evidence that the renderer can render it. */
export function registerPayloadHealthIpc(options: {
  readonly ipcMain: {
    handle(channel: string, listener: (event: { sender: HealthSender }, status?: unknown) => unknown): void;
    removeHandler(channel: string): void;
  };
  readonly isTrustedSender: (sender: HealthSender) => boolean;
  readonly noteBootSuccess: () => Promise<void>;
}) {
  let loaded = false;
  let ready = false;
  let failed = false;
  let disposed = false;
  let confirmation: Promise<void> | undefined;

  const confirm = async (): Promise<void> => {
    if (disposed || failed || !loaded || !ready) return;
    // Install one promise before running external code; duplicate IPC/load events
    // must not race two current.json writes.
    confirmation ??= Promise.resolve().then(() => {
      if (!disposed && !failed) return options.noteBootSuccess();
    });
    await confirmation;
  };

  options.ipcMain.removeHandler(PAYLOAD_HEALTH_CHANNEL);
  options.ipcMain.handle(PAYLOAD_HEALTH_CHANNEL, async (event, status) => {
    if (disposed || event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) return false;
    if (status !== "ready" && status !== "failed") return false;
    if (status === "failed") failed = true;
    else ready = true;
    await confirm();
    return !failed;
  });

  return {
    async didFinishLoad(): Promise<void> {
      loaded = true;
      await confirm();
    },
    failed(): void { failed = true; },
    dispose(): void {
      disposed = true;
      options.ipcMain.removeHandler(PAYLOAD_HEALTH_CHANNEL);
    },
  };
}

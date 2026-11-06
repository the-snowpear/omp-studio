import { MEMORY_CREDENTIAL_CHANNELS, type MemoryCredentialInput, type MemoryCredentialResult } from "./memory-credentials-shared.js";
import type { MemoryCredentialStore } from "./memory-credentials.js";

interface Sender { getURL(): string; isDestroyed(): boolean }
interface Ipc { handle(channel: string, listener: (event: { sender: Sender }, input: unknown) => unknown): void; removeHandler(channel: string): void }

export function registerMemoryCredentialIpc(options: { ipcMain: Ipc; isTrustedSender(sender: Sender): boolean; store: MemoryCredentialStore; activeTarget(): string | null; supportsSync(target: string | null): boolean }): { dispose(): void } {
  for (const action of ["status", "set", "remove"] as const) {
    options.ipcMain.handle(MEMORY_CREDENTIAL_CHANNELS[action], async (event, raw): Promise<MemoryCredentialResult> => {
      if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) throw new Error("Untrusted memory credential request");
      const input = raw as MemoryCredentialInput & { token?: string };
      if (!input || typeof input.url !== "string" || input.targetId !== options.activeTarget()) return { ok: false, message: "运行环境已切换，请刷新设置 / Execution target changed; refresh settings" };
      const target = input.targetId === null ? "local" : `ssh:${input.targetId}`;
      try {
        if (action === "set") {
          if (typeof input.token !== "string" || input.token.length === 0) return { ok: false, message: "请输入令牌 / Enter a token" };
          await options.store.set(target, input.url, input.token);
        } else if (action === "remove") await options.store.set(target, input.url, undefined);
        return { ok: true, configured: await options.store.has(target, input.url), syncSupported: options.supportsSync(input.targetId) };
      } catch {
        return { ok: false, message: "无法访问加密存储或服务地址无效 / Secure storage is unavailable or the service URL is invalid" };
      }
    });
  }
  return { dispose() { for (const channel of Object.values(MEMORY_CREDENTIAL_CHANNELS)) options.ipcMain.removeHandler(channel); } };
}

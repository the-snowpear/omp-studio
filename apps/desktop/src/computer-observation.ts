import { lstat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { validateComputerObservationResult } from "@omp-studio/studio-protocol";
import type { TerminalIpcMain, TerminalSender } from "./terminal-ipc.js";
import { COMPUTER_CAPTURE_CHANNEL, type ComputerCaptureResult } from "./computer-observation-shared.js";
/** One-use, bounded screenshot file delivery on private chrome IPC, never through Host events. */
export function registerComputerCaptureIpc(options: { ipcMain: TerminalIpcMain; directory(): string; isTrustedSender(sender: TerminalSender): boolean; isVisible(sender: TerminalSender): boolean }): { dispose(): void } {
  const claims = new Set<string>(); let disposed = false;
  options.ipcMain.handle(COMPUTER_CAPTURE_CHANNEL, async ({ sender }, value): Promise<ComputerCaptureResult> => {
    if (disposed || sender.isDestroyed() || !options.isTrustedSender(sender) || !options.isVisible(sender)) return { ok: false, message: "Computer observation requires a visible trusted window" };
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Invalid capture request" };
    const request = value as Record<string, unknown>;
    if (Object.keys(request).some(key => !["captureId", "sessionId", "targetId"].includes(key)) || typeof request.captureId !== "string" || !/^[a-f0-9-]{36}$/u.test(request.captureId) || typeof request.sessionId !== "string" || typeof request.targetId !== "string" || request.sessionId.length > 512 || request.targetId.length > 1024 || claims.has(request.captureId)) return { ok: false, message: "Invalid or already consumed capture" };
    if (claims.size >= 4) return { ok: false, message: "Too many capture reads" };
    const id = request.captureId; claims.add(id); let owned = false;
    const metadata = join(options.directory(), "computer", id + ".json"); const payload = join(options.directory(), "computer", id + ".png");
    try {
      const metaInfo = await lstat(metadata); const imageInfo = await lstat(payload);
      if (!metaInfo.isFile() || metaInfo.isSymbolicLink() || metaInfo.size > 4096 || !imageInfo.isFile() || imageInfo.isSymbolicLink() || imageInfo.size > 8 * 1024 * 1024) throw new Error("Capture outside resource limits");
      const descriptor = JSON.parse(await readFile(metadata, "utf8")) as Record<string, unknown>; validateComputerObservationResult("computer.capture", descriptor);
      if (descriptor.captureId !== id || descriptor.sessionId !== request.sessionId || descriptor.targetId !== request.targetId || typeof descriptor.expiresAt !== "number" || descriptor.expiresAt < Date.now() || descriptor.expiresAt > Date.now() + 60000) throw new Error("Capture expired");
      owned = true;
      const bytes = await readFile(payload);
      if (bytes.byteLength < 33 || bytes.byteLength > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== descriptor.width || bytes.readUInt32BE(20) !== descriptor.height) throw new Error("Invalid capture encoding or dimensions");
      if (disposed || sender.isDestroyed() || !options.isTrustedSender(sender) || !options.isVisible(sender)) throw new Error("Capture view closed");
      return { ok: true, data: Uint8Array.from(bytes).buffer, width: Number(descriptor.width), height: Number(descriptor.height) };
    } catch { return { ok: false, message: "Computer capture unavailable, expired, or outside the resource budget" }; }
    finally { if (owned) await Promise.all([unlink(metadata).catch(() => {}), unlink(payload).catch(() => {})]); claims.delete(id); }
  });
  return { dispose() { disposed = true; claims.clear(); options.ipcMain.removeHandler(COMPUTER_CAPTURE_CHANNEL); } };
}

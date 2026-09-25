import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { TerminalIpcMain, TerminalSender } from "./terminal-ipc.js";
import { SKILLSHARE_TOKEN_CHANNEL, type SkillshareTokenReveal } from "./chrome-skillshare-shared.js";
/** One-time current-user handoff. Never route this result through Host receipts or snapshots. */
export async function takeSkillshareToken(directory: string, raw: unknown): Promise<{ token: string; name: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "secretId" && key !== "sessionId")) throw new Error("Invalid secret request");
  const input = raw as Record<string, unknown>;
  if (typeof input.secretId !== "string" || !/^[a-f0-9-]{36}$/u.test(input.secretId) || typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 512) throw new Error("Invalid secret identity");
  const file = join(directory, "skillshare", "secrets", input.secretId + ".json");
  const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error("Invalid secret descriptor");
  const value = JSON.parse(await readFile(file, "utf8")) as { sessionId?: unknown; token?: unknown; name?: unknown; expiresAt?: unknown };
  if (value.sessionId !== input.sessionId) throw new Error("Secret belongs to another session");
  if (typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()) { await unlink(file).catch(() => {}); throw new Error("Secret expired"); }
  if (value.expiresAt > Date.now() + 121000 || typeof value.token !== "string" || !/^sks_[A-Za-z0-9_-]+$/u.test(value.token) || value.token.length > 4096 || typeof value.name !== "string" || value.name.length > 128) throw new Error("Invalid secret handoff");
  const claim = file + "." + randomUUID() + ".claim";
  await rename(file, claim);
  try { return { token: value.token, name: value.name }; }
  finally { await unlink(claim); }
}
export function registerSkillshareTokenIpc(options: { ipcMain: TerminalIpcMain; isTrustedSender(sender: TerminalSender): boolean; directory(): string }): { dispose(): void } {
  options.ipcMain.handle(SKILLSHARE_TOKEN_CHANNEL, async ({ sender }, input): Promise<SkillshareTokenReveal> => {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) throw new Error("Untrusted secret recipient");
    try { const value = await takeSkillshareToken(options.directory(), input); if (sender.isDestroyed()) return { ok: false, message: "The receiving window closed; revoke the token if it was not saved." }; return { ok: true, ...value }; }
    catch { return { ok: false, message: "This token can no longer be revealed. It may have expired or already been read. Revoke it before creating a replacement if necessary." }; }
  });
  return { dispose: () => options.ipcMain.removeHandler(SKILLSHARE_TOKEN_CHANNEL) };
}

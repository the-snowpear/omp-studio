/**
 * Microphone access before Live starts.
 *
 * On macOS the first `getUserMedia` of an app triggers the system prompt, and a
 * denied app never sees another one: the user has to allow it in System
 * Settings. Main therefore reports the status up front, asks while it is still
 * undetermined, and opens the Microphone privacy page from a fixed URL — the
 * renderer never supplies one. Windows reports `granted` and keeps relying on
 * Chromium.
 */
import { CHROME_MEDIA_ACCESS_CHANNELS, type MicrophoneAccess } from "./chrome-media-access-shared.js";

export const MICROPHONE_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

export interface MediaAccessPreferences {
  getMediaAccessStatus(mediaType: "microphone"): "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  askForMediaAccess(mediaType: "microphone"): Promise<boolean>;
}

export async function microphoneAccess(platform: NodeJS.Platform, preferences: MediaAccessPreferences): Promise<MicrophoneAccess> {
  if (platform !== "darwin") return "granted";
  const status = preferences.getMediaAccessStatus("microphone");
  if (status === "granted") return "granted";
  if (status === "not-determined" || status === "unknown") return (await preferences.askForMediaAccess("microphone")) ? "granted" : "denied";
  return "denied";
}

export interface MediaAccessIpcMain {
  handle(channel: string, listener: (event: { sender: { isDestroyed(): boolean; getURL(): string } }) => unknown): void;
  removeHandler(channel: string): void;
}

export function registerMediaAccessIpc(options: {
  readonly ipcMain: MediaAccessIpcMain;
  readonly isTrustedSender: (sender: { isDestroyed(): boolean; getURL(): string }) => boolean;
  readonly platform: NodeJS.Platform;
  readonly preferences: MediaAccessPreferences;
  readonly openExternal: (url: string) => Promise<void>;
}): { dispose(): void } {
  const trusted = (sender: { isDestroyed(): boolean; getURL(): string }): boolean => !sender.isDestroyed() && options.isTrustedSender(sender);
  options.ipcMain.handle(CHROME_MEDIA_ACCESS_CHANNELS.microphone, async ({ sender }) => {
    if (!trusted(sender)) throw new Error("Untrusted media access request");
    return await microphoneAccess(options.platform, options.preferences);
  });
  options.ipcMain.handle(CHROME_MEDIA_ACCESS_CHANNELS.openMicrophoneSettings, async ({ sender }) => {
    if (!trusted(sender)) throw new Error("Untrusted media access request");
    if (options.platform !== "darwin") return false;
    await options.openExternal(MICROPHONE_SETTINGS_URL);
    return true;
  });
  return {
    dispose() {
      for (const channel of Object.values(CHROME_MEDIA_ACCESS_CHANNELS)) options.ipcMain.removeHandler(channel);
    },
  };
}

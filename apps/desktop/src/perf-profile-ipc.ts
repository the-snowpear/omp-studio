/**
 * Desktop-chrome IPC for the read-only GPU/performance profile (P0-6).
 *
 * Three channels, all read-only from the Renderer's point of view:
 * - `PERF_PROFILE_CHANNELS.probe` — `invoke`, returns the current snapshot
 *   (re-probing when the last probe is stale).
 * - `PERF_PROFILE_CHANNELS.cached` — `sendSync`, used once by the preload so
 *   the Renderer has a tier before its first paint (no flash of the full
 *   animation set on a software-compositing machine).
 * - `PERF_PROFILE_CHANNELS.changed` — Main → Renderer push after a GPU or
 *   power change.
 *
 * There is deliberately no write channel: user overrides (`motion: off`,
 * `gpuTier`) are Renderer settings, stored by the Renderer's own settings
 * layer, and only ever tighten what Main reports.
 *
 * Electron-free: `ipcMain`, the snapshot source and the trust predicate are
 * injected, so tests run headlessly.
 */

import {
  PERF_PROFILE_CHANNELS,
  type PerfProfileSender,
  type PerfProfileSnapshot,
} from "./perf-profile-shared.js";

/** Minimal shape of an Electron `IpcMainInvokeEvent` / `IpcMainEvent`. */
export interface PerfProfileIpcEvent {
  readonly sender: PerfProfileSender;
  returnValue?: unknown;
}

export interface PerfProfileIpcMain {
  handle(channel: string, listener: (event: PerfProfileIpcEvent) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: PerfProfileIpcEvent) => void): void;
  removeListener(channel: string, listener: (event: PerfProfileIpcEvent) => void): void;
}

/** What this module needs from the profile service. */
export interface PerfProfileSource {
  probe(): Promise<PerfProfileSnapshot>;
  current(): PerfProfileSnapshot | undefined;
}

export interface PerfProfileIpcOptions {
  readonly ipcMain: PerfProfileIpcMain;
  readonly isTrustedSender: (sender: PerfProfileSender) => boolean;
  readonly service: PerfProfileSource;
}

export interface PerfProfileIpcHandle {
  dispose(): void;
}

export function registerPerfProfileIpc(options: PerfProfileIpcOptions): PerfProfileIpcHandle {
  const trusted = (sender: PerfProfileSender): boolean => !sender.isDestroyed() && options.isTrustedSender(sender);

  options.ipcMain.handle(PERF_PROFILE_CHANNELS.probe, async (event) => {
    // Same posture as the other chrome channels: an untrusted caller gets
    // "no answer" (null) instead of a thrown error it could probe with.
    if (!trusted(event.sender)) return null;
    try {
      return await options.service.probe();
    } catch {
      return options.service.current() ?? null;
    }
  });

  const cachedListener = (event: PerfProfileIpcEvent): void => {
    // `sendSync`: the return value must be set synchronously.
    event.returnValue = trusted(event.sender) ? (options.service.current() ?? null) : null;
  };
  options.ipcMain.on(PERF_PROFILE_CHANNELS.cached, cachedListener);

  return {
    dispose(): void {
      options.ipcMain.removeHandler(PERF_PROFILE_CHANNELS.probe);
      options.ipcMain.removeListener(PERF_PROFILE_CHANNELS.cached, cachedListener);
    },
  };
}

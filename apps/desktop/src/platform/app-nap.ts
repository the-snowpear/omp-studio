/**
 * App Nap guard.
 *
 * macOS naps a hidden app: timers are coalesced and I/O is deprioritised,
 * which stalls a streaming turn in a window the user has closed to the Dock.
 * Hold `prevent-app-suspension` only while a session is busy — the same
 * blocker also keeps the Mac from idle-sleeping, so it must not be held for an
 * idle app.
 */

export interface PowerSaveBlockerLike {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

export interface AppNapGuardOptions {
  readonly isBusy: () => boolean;
  readonly blocker: PowerSaveBlockerLike;
  readonly intervalMs?: number;
  readonly setInterval?: (callback: () => void, intervalMs: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

function scheduleUnref(callback: () => void, intervalMs: number): unknown {
  const handle = setInterval(callback, intervalMs);
  handle.unref?.();
  return handle;
}

function cancelInterval(handle: unknown): void {
  clearInterval(handle as NodeJS.Timeout);
}

/** Polls busy state; returns a disposer that also releases a held blocker. */
export function startAppNapGuard(options: AppNapGuardOptions): () => void {
  let held: number | undefined;
  const sync = (): void => {
    const busy = options.isBusy();
    if (busy && held === undefined) held = options.blocker.start("prevent-app-suspension");
    else if (!busy && held !== undefined) {
      options.blocker.stop(held);
      held = undefined;
    }
  };
  const handle = (options.setInterval ?? scheduleUnref)(sync, options.intervalMs ?? 5_000);
  sync();
  return () => {
    (options.clearInterval ?? cancelInterval)(handle);
    if (held !== undefined) options.blocker.stop(held);
    held = undefined;
  };
}

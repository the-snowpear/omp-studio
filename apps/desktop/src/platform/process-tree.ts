/**
 * Killing a child together with everything it started.
 *
 * Windows walks the tree with `taskkill /t /f`. POSIX has no tree walk, so the
 * child is spawned as the leader of its own process group
 * ({@link processGroupSpawnOptions}) and the whole group is signalled; that is
 * what reaches git's ssh and credential helpers or a shell's jobs.
 */
import { spawn, type ChildProcess } from "node:child_process";

export function processGroupSpawnOptions(platform: NodeJS.Platform = process.platform): { readonly detached?: true } {
  return platform === "win32" ? {} : { detached: true };
}

export interface ProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  /** Test seam for `process.kill(-pgid, signal)`. */
  readonly killGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  /** Test seam for launching `taskkill.exe`. */
  readonly spawnTaskkill?: (pid: number) => void;
}

function spawnTaskkill(pid: number): void {
  const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true, shell: false });
  killer.on("error", () => { /* best effort */ });
  killer.unref();
}

export function terminateProcessTree(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  signal: NodeJS.Signals = "SIGKILL",
  options: ProcessTreeOptions = {},
): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if ((options.platform ?? process.platform) === "win32") {
    (options.spawnTaskkill ?? spawnTaskkill)(child.pid);
    return;
  }
  try {
    (options.killGroup ?? ((pgid, groupSignal) => process.kill(-pgid, groupSignal)))(child.pid, signal);
  } catch {
    // Not a group leader, or already gone.
    child.kill(signal);
  }
}

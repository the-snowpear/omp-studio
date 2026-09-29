import type { ChildProcess } from "node:child_process";
import type { RuntimeContainmentPort } from "./runtime-process-port.js";

/** Spawn options that make a POSIX Runtime the leader of its own process group. */
export const POSIX_PROCESS_GROUP_SPAWN_OPTIONS = Object.freeze({ detached: true } as const);

type ContainedProcess = Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">;

/**
 * POSIX containment: the Runtime is spawned as a process-group leader
 * ({@link POSIX_PROCESS_GROUP_SPAWN_OPTIONS}), so stop signals reach every
 * tool process it started. The group is signalled only while its leader is
 * unreaped: once Node has reaped the leader its id may eventually be reused.
 */
export class PosixProcessGroupContainment implements RuntimeContainmentPort {
  constructor(
    private readonly killGroup: (pgid: number, signal: NodeJS.Signals) => void = (pgid, signal) => {
      process.kill(-pgid, signal);
    },
  ) {}

  requestStop(child: ContainedProcess): void {
    this.#signal(child, "SIGTERM");
  }

  forceStop(child: ContainedProcess): void {
    this.#signal(child, "SIGKILL");
  }

  #signal(child: ContainedProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      this.killGroup(child.pid, signal);
    } catch {
      // Not a group leader (spawned without `detached`) or already gone.
      child.kill(signal);
    }
  }
}

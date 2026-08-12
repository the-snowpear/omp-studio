import { spawn } from "node:child_process";

/**
 * Runs a functional check against an installed Runtime entrypoint before the
 * installer switches `current.json`. Production callers may inject a custom
 * runner; tests inject fakes so no untrusted file is ever executed.
 */
export interface SelfCheckRunner {
  run(entrypointPath: string): Promise<void>;
}

/** Minimal structural view of a child process used by the default runner. */
export interface SelfCheckChild {
  once(
    event: "error" | "close",
    listener: (value?: unknown) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** Test seam: mirrors node:child_process spawn for the arguments we use. */
export interface SelfCheckSpawn {
  (
    command: string,
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; stdio: "ignore"; windowsHide: boolean },
  ): SelfCheckChild;
}

export interface SmokeTestRunnerOptions {
  timeoutMs?: number;
  /** Time allowed for a timed-out child to report close after forced termination. */
  killGraceMs?: number;
  /** Defaults to ["--smoke-test"]. */
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Injectable spawn; defaults to node:child_process spawn. */
  spawn?: SelfCheckSpawn;
}

const DEFAULT_SMOKE_ARGS = ["--smoke-test"] as const;
const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

const defaultSpawn: SelfCheckSpawn = (command, args, options) =>
  spawn(command, [...args], options);

/**
 * Default activation self-check: runs `entrypoint --smoke-test` with a
 * timeout, hidden window, and no inherited stdio, resolving only on exit 0.
 */
export function createSmokeTestRunner(
  options: SmokeTestRunnerOptions = {},
): SelfCheckRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const args = options.args ?? DEFAULT_SMOKE_ARGS;
  const env = options.env ?? process.env;
  const runProcess = options.spawn ?? defaultSpawn;

  return {
    run(entrypointPath) {
      return new Promise<void>((resolve, reject) => {
        let child: SelfCheckChild;
        try {
          child = runProcess(entrypointPath, args, {
            env,
            stdio: "ignore",
            windowsHide: true,
          });
        } catch (error) {
          reject(
            new Error(
              `Failed to start activation self-check for ${entrypointPath}: ${(error as Error).message}`,
              { cause: error },
            ),
          );
          return;
        }

        let settled = false;
        let timedOut = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const timeoutError = () =>
          new Error(`Activation self-check for ${entrypointPath} timed out after ${timeoutMs}ms`);
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          action();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
          killTimer = setTimeout(() => settle(() => reject(timeoutError())), killGraceMs);
        }, timeoutMs);

        child.once("error", (error) => {
          settle(() =>
            reject(
              timedOut
                ? timeoutError()
                : new Error(
                    `Activation self-check for ${entrypointPath} failed to start: ${(error as Error).message}`,
                    { cause: error },
                  ),
            ),
          );
        });
        child.once("close", (codeOrSignal) => {
          if (timedOut) {
            settle(() => reject(timeoutError()));
            return;
          }
          const code = typeof codeOrSignal === "number" ? codeOrSignal : undefined;
          if (code === 0) {
            settle(resolve);
          } else {
            settle(() =>
              reject(
                new Error(
                  `Activation self-check for ${entrypointPath} failed with exit ${code ?? codeOrSignal ?? "unknown"}`,
                ),
              ),
            );
          }
        });
      });
    },
  };
}

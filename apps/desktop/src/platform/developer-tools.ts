/**
 * Apple's Command Line Tools shims.
 *
 * On a Mac without the Command Line Tools, `/usr/bin/git` is a stub that pops
 * a system "install developer tools" dialog every time it runs. Studio probes
 * git in the background, so the stub must never run unasked: before spawning
 * a shim, check that the active developer directory really has the tool, and
 * report the missing Command Line Tools instead. Homebrew or other PATH
 * entries that shadow `/usr/bin` are unaffected.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { posix } from "node:path";

export const COMMAND_LINE_TOOLS_MISSING =
  "Xcode Command Line Tools are not installed; run `xcode-select --install` in Terminal, or install git with Homebrew";

/** `/usr/bin` entries that are `xcrun` stubs rather than real programs. */
const XCRUN_SHIMS = new Set(["git", "make", "clang", "cc", "python3"]);
const RETRY_MISSING_MS = 30_000;

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The file `execvp` would run for a bare command name. */
export function resolveCommandOnPath(
  command: string,
  pathEnv: string | undefined,
  isExecutable: (path: string) => boolean = isExecutableFile,
): string | undefined {
  if (command.includes("/")) return command;
  for (const directory of (pathEnv ?? "").split(":")) {
    if (directory.length === 0) continue;
    const candidate = posix.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** `xcode-select -p` never prompts; it fails when no developer directory is configured. */
function activeDeveloperDirectory(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("/usr/bin/xcode-select", ["-p"], { env, timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      const directory = stdout.trim();
      resolve(error === null && directory.startsWith("/") ? directory : undefined);
    });
  });
}

export interface CommandLineToolsGuard {
  /** Why `command` must not be spawned, or `undefined` when it is safe. */
  unavailableReason(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
}

export interface CommandLineToolsGuardOptions {
  readonly developerDirectory?: (env: NodeJS.ProcessEnv) => Promise<string | undefined>;
  readonly isExecutable?: (path: string) => boolean;
  readonly exists?: (path: string) => boolean;
  readonly now?: () => number;
}

export function createCommandLineToolsGuard(options: CommandLineToolsGuardOptions = {}): CommandLineToolsGuard {
  const developerDirectory = options.developerDirectory ?? activeDeveloperDirectory;
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const exists = options.exists ?? existsSync;
  const now = options.now ?? Date.now;
  // An installed tool stays installed; a missing one is re-checked so installing
  // the Command Line Tools takes effect without restarting Studio.
  const installed = new Set<string>();
  const missingUntil = new Map<string, number>();
  return {
    async unavailableReason(command, env) {
      if (!XCRUN_SHIMS.has(command) || installed.has(command)) return undefined;
      if (resolveCommandOnPath(command, env.PATH, isExecutable) !== `/usr/bin/${command}`) return undefined;
      if ((missingUntil.get(command) ?? 0) > now()) return COMMAND_LINE_TOOLS_MISSING;
      const directory = await developerDirectory(env);
      if (directory !== undefined && exists(posix.join(directory, "usr", "bin", command))) {
        installed.add(command);
        missingUntil.delete(command);
        return undefined;
      }
      missingUntil.set(command, now() + RETRY_MISSING_MS);
      return COMMAND_LINE_TOOLS_MISSING;
    },
  };
}

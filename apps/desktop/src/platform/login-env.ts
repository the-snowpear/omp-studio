/**
 * Login-shell environment for GUI-launched macOS apps.
 *
 * LaunchServices starts apps with launchd's minimal environment
 * (PATH=/usr/bin:/bin:/usr/sbin:/sbin, usually no LANG), so Homebrew, nvm,
 * bun and cargo tools are invisible to the Runtime, git and the terminal.
 * Like VS Code, ask the user's login shell once for its environment and merge
 * it into `process.env` before the Host spawns anything. A slow or broken
 * shell profile only costs the timeout; well-known tool directories and a
 * UTF-8 `LANG` are filled in either way.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir as osHomedir, userInfo } from "node:os";
import { basename, posix } from "node:path";

export type LoginEnvironmentStatus = "resolved" | "timeout" | "failed" | "skipped";

export interface LoginEnvironmentResult {
  readonly env: NodeJS.ProcessEnv;
  readonly status: LoginEnvironmentStatus;
}

export interface ShellRunResult {
  readonly stdout: string;
  readonly timedOut: boolean;
}

export type ShellRunner = (shell: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<ShellRunResult>;

const MARK = "__OMP_STUDIO_LOGIN_ENV__";
/** Set while the profile runs, so users can skip slow setup: `[[ -n $OMP_STUDIO_RESOLVING_ENVIRONMENT ]] && return`. */
const RESOLVING_FLAG = "OMP_STUDIO_RESOLVING_ENVIRONMENT";
/** Electron's own switches and Studio's private Runtime channel never come from a profile. */
const PRESERVED = /^(?:ELECTRON_|OMP_STUDIO_)/u;
const SHELL_BOOKKEEPING = new Set(["PATH", "SHLVL", "PWD", "OLDPWD", "_"]);
const FALLBACK_PATH = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "~/.bun/bin", "~/.local/bin", "~/.cargo/bin"];
const MAX_OUTPUT = 1_000_000;

/** The JSON object between the two markers; profile noise around it is ignored. */
export function parseLoginEnvironmentOutput(stdout: string): Record<string, string> | undefined {
  const start = stdout.indexOf(MARK);
  const end = stdout.lastIndexOf(MARK);
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start + MARK.length, end));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") result[key] = value;
    return result;
  } catch {
    return undefined;
  }
}

function hasClosingMark(stdout: string): boolean {
  const start = stdout.indexOf(MARK);
  return start !== -1 && stdout.lastIndexOf(MARK) > start;
}

function mergePath(first: string | undefined, second: string | undefined): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const entry of `${first ?? ""}:${second ?? ""}`.split(":")) {
    if (entry.length === 0 || seen.has(entry)) continue;
    seen.add(entry);
    entries.push(entry);
  }
  return entries.join(":");
}

/** Shell values win except preserved switches; PATH keeps the shell's order, then anything only the app had. */
export function mergeLoginEnvironment(current: NodeJS.ProcessEnv, shell: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...current };
  for (const [key, value] of Object.entries(shell)) {
    if (PRESERVED.test(key) || SHELL_BOOKKEEPING.has(key)) continue;
    merged[key] = value;
  }
  merged.PATH = mergePath(shell.PATH, current.PATH);
  return merged;
}

export function withFallbackPath(current: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const fallback = FALLBACK_PATH.map((entry) => (entry.startsWith("~/") ? posix.join(home, entry.slice(2)) : entry)).join(":");
  return { ...current, PATH: mergePath(current.PATH, fallback) };
}

const SCRIPT_REGIONS: Readonly<Record<string, string>> = { "zh-hans": "zh_CN", "zh-hant": "zh_TW" };

function systemHasLocale(name: string): boolean {
  return existsSync(posix.join("/usr/share/locale", name));
}

/** `zh-CN` → `zh_CN.UTF-8`; anything the system has no locale for becomes `en_US.UTF-8`. */
export function localeToLang(locale: string, hasLocale: (name: string) => boolean = systemHasLocale): string {
  const normalized = locale.trim().replace(/_/gu, "-");
  const match = /^([a-z]{2,3})(?:-[A-Za-z]{4})?-([A-Za-z]{2})(?:$|-)/u.exec(normalized);
  const base = match !== null ? `${match[1]}_${match[2]!.toUpperCase()}` : SCRIPT_REGIONS[normalized.toLowerCase()];
  const candidate = base === undefined ? undefined : `${base}.UTF-8`;
  return candidate !== undefined && hasLocale(candidate) ? candidate : "en_US.UTF-8";
}

function withLang(env: NodeJS.ProcessEnv, locale: string | undefined, hasLocale: ((name: string) => boolean) | undefined): NodeJS.ProcessEnv {
  if (env.LANG || env.LC_ALL || env.LC_CTYPE) return env;
  return { ...env, LANG: localeToLang(locale ?? "", hasLocale) };
}

/** `userInfo()` throws for an account without a passwd entry. */
function accountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** csh and tcsh reject `-l` next to other flags. */
export function loginShellArgs(shell: string): readonly string[] {
  const name = basename(shell);
  return name === "csh" || name === "tcsh" ? ["-ic"] : ["-i", "-l", "-c"];
}

/**
 * Settles on the closing marker, on exit, or on the timeout — whichever comes
 * first — so a profile daemon that keeps stdout open cannot stall startup.
 */
const defaultShellRunner: ShellRunner = (shell, args, env, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    // setsid: no controlling terminal for `-i`, and one group to kill on timeout.
    const child = spawn(shell, [...args], { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const settle = (timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      child.stdout.destroy();
      child.unref();
      resolve({ stdout, timedOut });
    };
    const timer = setTimeout(() => settle(true), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
      if (hasClosingMark(stdout)) settle(false);
    });
    child.once("error", () => settle(false));
    child.once("close", () => settle(false));
  });

export interface LoginEnvironmentOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** The Electron binary, run as Node to print the environment. */
  readonly execPath?: string;
  /** `app.getLocale()`, used when neither the app nor the profile sets `LANG`. */
  readonly locale?: string;
  readonly homedir?: string;
  readonly timeoutMs?: number;
  readonly run?: ShellRunner;
  readonly hasLocale?: (name: string) => boolean;
}

export async function resolveLoginEnvironment(options: LoginEnvironmentOptions = {}): Promise<LoginEnvironmentResult> {
  const env = options.env ?? process.env;
  // Windows apps inherit the user's environment, and so does anything started from a terminal.
  if ((options.platform ?? process.platform) !== "darwin" || env.TERM !== undefined || env.TERM_PROGRAM !== undefined) {
    return { env, status: "skipped" };
  }
  const shell = env.SHELL || accountShell() || "/bin/zsh";
  const printer = `${shellQuote(options.execPath ?? process.execPath)} -p ${shellQuote(`"${MARK}" + JSON.stringify(process.env) + "${MARK}"`)}`;
  let result: ShellRunResult;
  try {
    result = await (options.run ?? defaultShellRunner)(
      shell,
      [...loginShellArgs(shell), printer],
      { ...env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", [RESOLVING_FLAG]: "1" },
      options.timeoutMs ?? 10_000,
    );
  } catch {
    result = { stdout: "", timedOut: false };
  }
  const parsed = result.timedOut ? undefined : parseLoginEnvironmentOutput(result.stdout);
  const status: LoginEnvironmentStatus = parsed !== undefined ? "resolved" : result.timedOut ? "timeout" : "failed";
  const merged = parsed === undefined ? env : mergeLoginEnvironment(env, parsed);
  return { env: withLang(withFallbackPath(merged, options.homedir ?? osHomedir()), options.locale, options.hasLocale), status };
}

let applied: Promise<LoginEnvironmentStatus> | undefined;

/**
 * Resolves once per process and writes the result into `process.env` for every
 * later spawn. Never rejects: Host startup waits on it.
 */
export function applyLoginEnvironment(options: Omit<LoginEnvironmentOptions, "env"> = {}): Promise<LoginEnvironmentStatus> {
  applied ??= resolveLoginEnvironment({ ...options, env: process.env }).then(
    ({ env, status }) => {
      for (const [key, value] of Object.entries(env)) if (value !== undefined && process.env[key] !== value) process.env[key] = value;
      return status;
    },
    (): LoginEnvironmentStatus => "failed",
  );
  return applied;
}

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const repositoryRoot = resolve(import.meta.dirname, "..");
export const ompSourceDirectory = join(repositoryRoot, "omp-patch", "vendor", "oh-my-pi");

function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function findOnPath(name) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [executableName(name)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/u).find(Boolean) ?? null;
}

export function findBun() {
  const configured = process.env.BUN_EXE;
  if (configured && existsSync(configured)) return configured;

  const onPath = findOnPath("bun");
  if (onPath) return onPath;

  const userProfile = process.env.USERPROFILE ?? process.env.HOME;
  const fallback = userProfile
    ? join(userProfile, ".bun", "bin", executableName("bun"))
    : null;
  if (fallback && existsSync(fallback)) return fallback;

  throw new Error("Bun was not found. Install Bun 1.3.14 or set BUN_EXE.");
}

export function toolingEnvironment(extra = {}) {
  const bunDirectory = dirname(findBun());
  const userProfile = process.env.USERPROFILE ?? process.env.HOME;
  const cargoDirectory = userProfile ? join(userProfile, ".cargo", "bin") : null;
  const currentPath = process.env.Path ?? process.env.PATH ?? "";
  const pathEntries = [bunDirectory, cargoDirectory, currentPath].filter(Boolean);

  return {
    ...process.env,
    Path: pathEntries.join(process.platform === "win32" ? ";" : ":"),
    PATH: pathEntries.join(process.platform === "win32" ? ";" : ":"),
    DO_NOT_TRACK: "1",
    ...extra,
  };
}

export function npmInvocation() {
  if (process.platform !== "win32") {
    return { command: "npm", prefix: [] };
  }
  const npmCli =
    process.env.OMP_NPM_CLI ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) {
    throw new Error(`npm CLI was not found at ${npmCli}`);
  }
  return { command: process.execPath, prefix: [npmCli] };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? toolingEnvironment(),
    encoding: options.capture ? "utf8" : undefined,
    stdio: options.capture ? "pipe" : (options.stdio ?? ["ignore", "inherit", "inherit"]),
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${detail}`);
  }

  return options.capture ? result.stdout.trim() : "";
}

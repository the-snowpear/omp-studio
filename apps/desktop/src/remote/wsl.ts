import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WslDistribution, WslInventory } from "./shared.js";
import { desktopText } from "../desktop-language-shared.js";

export function wslExecutable(): string | undefined {
  if (process.platform !== "win32" || !process.env.SystemRoot) return;
  const file = join(process.env.SystemRoot, "System32", "wsl.exe");
  return existsSync(file) ? file : undefined;
}
export function assertDistroName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) throw new Error(desktopText("无效的 WSL 发行版名称", "Invalid WSL distribution name"));
}
export function wslCommandArgs(distro: string | undefined, command: string): string[] {
  assertDistroName(distro);
  return ["--distribution", distro, "--cd", "~", "--exec", "/bin/sh", "-c", 'eval "$(printf %s "$1" | base64 -d)"', "omp-studio", Buffer.from(command).toString("base64")];
}
export function decodeWsl(bytes: Buffer): string {
  return bytes.toString(bytes.includes(0) ? "utf16le" : "utf8").replace(/^\uFEFF/u, "");
}
export function parseWslDistributions(verbose: Buffer, running: Buffer): WslDistribution[] {
  const active = new Set(decodeWsl(running).split(/\r?\n/u).map(line => line.trim()));
  const distributions: WslDistribution[] = [];
  for (const line of decodeWsl(verbose).split(/\r?\n/u)) {
    const row = /^\s*(\*)?\s*([^\s*]+)\s+.+\s+([12])\s*$/u.exec(line);
    if (!row || /^(?:docker|rancher)-desktop/iu.test(row[2]!)) continue;
    const name = row[2]!;
    distributions.push({ name, version: row[3] === "1" ? 1 : 2, running: active.has(name), isDefault: Boolean(row[1]) });
  }
  return distributions.sort((a,b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}
export async function listWslDistributions(): Promise<WslInventory> {
  const file = wslExecutable();
  if (!file) return { available: false, distributions: [] };
  const list = (args: string[]) => promisify(execFile)(file, args, { encoding: "buffer", windowsHide: true, timeout: 15_000, env: { ...process.env, WSL_UTF8: "1" } });
  try {
    const verbose = await list(["-l", "-v"]);
    const running = await list(["-l", "--running", "-q"]);
    return { available: true, distributions: parseWslDistributions(verbose.stdout, running.stdout) };
  } catch (error) {
    const failure = error as { stdout?: Buffer; stderr?: Buffer };
    const message = decodeWsl(failure.stdout ?? Buffer.alloc(0)) + decodeWsl(failure.stderr ?? Buffer.alloc(0));
    return { available: /WSL_E_DEFAULT_DISTRO_NOT_FOUND|no installed distributions|没有已安装的分发|未安装任何分发/iu.test(message), distributions: [] };
  }
}

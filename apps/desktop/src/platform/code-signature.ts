/**
 * Apple Silicon kills a Mach-O with a missing or broken code signature the
 * moment it runs, so a smoke test of such a Runtime only reports a SIGKILL.
 * Verifying the signature first gives the activation a clear reason instead.
 * Other platforms get the runner back unchanged.
 */
import { execFile } from "node:child_process";
import type { SelfCheckRunner } from "@omp-studio/runtime-installer";

export type RunFile = (file: string, args: readonly string[]) => Promise<void>;

const execFileRun: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", timeout: 60_000 }, (error, _stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 500)));
      else resolve();
    });
  });

export function withCodeSignatureCheck(
  runner: SelfCheckRunner,
  options: { readonly platform?: NodeJS.Platform; readonly run?: RunFile } = {},
): SelfCheckRunner {
  if ((options.platform ?? process.platform) !== "darwin") return runner;
  const run = options.run ?? execFileRun;
  return {
    async run(entrypointPath) {
      try {
        await run("/usr/bin/codesign", ["--verify", "--strict", entrypointPath]);
      } catch (error) {
        throw new Error(`Runtime 的代码签名无效，macOS 会拒绝运行它：${error instanceof Error ? error.message : String(error)}`);
      }
      await runner.run(entrypointPath);
    },
  };
}

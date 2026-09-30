/**
 * macOS flags files that arrive from the internet with `com.apple.quarantine`,
 * and a copy keeps the flag. The Runtime seeded out of a downloaded app bundle
 * would carry it into the per-user Runtime tree, where Gatekeeper assesses the
 * ad hoc signed `omp` as a standalone download and refuses to run it.
 *
 * The Runtime installer calls this on its private staged copy, never on the
 * signed bundle, and then verifies that copy against the Ed25519 signature and
 * checksums: those remain the trust gate for what gets published.
 */
import { execFile } from "node:child_process";

export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";

export type RunFile = (file: string, args: readonly string[]) => Promise<void>;

const execFileRun: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 30_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve();
    });
  });

/**
 * Never throws: a flag that stays behind shows up as the Runtime's own start
 * failure, with this warning next to it in the host log.
 */
export async function clearQuarantine(
  directory: string,
  options: { readonly run?: RunFile; readonly warn?: (detail: string) => void } = {},
): Promise<void> {
  try {
    await (options.run ?? execFileRun)("/usr/bin/xattr", ["-dr", QUARANTINE_ATTRIBUTE, directory]);
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
    // `xattr -d` also complains about the files that never had the flag.
    const problems = stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0 && !/no such xattr/iu.test(line));
    if (stderr.length > 0 && problems.length === 0) return;
    options.warn?.((problems.join("; ") || (error instanceof Error ? error.message : String(error))).slice(0, 500));
  }
}

// All electron-updater internal imports are isolated here and version-pinned.
// Discovery and authentication belong to our signed catalog, not app-update.yml.
import { spawn } from "node:child_process";
import { GenericDifferentialDownloader } from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { CancellationToken } from "builder-util-runtime";
import type { DifferentialInput } from "./differential-artifact.js";

export const electronDifferentialDownload: NonNullable<DifferentialInput["differential"]> = async (oldFile, newFile, url, oldMap, newMap, file, signal, progress) => {
  const cancellationToken = new CancellationToken();
  const cancel = () => cancellationToken.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await new GenericDifferentialDownloader({ size: file.size, sha512: file.sha512 }, new ElectronHttpExecutor(), {
      oldFile, newFile, newUrl: new URL(url), logger: console,
      requestHeaders: null, isUseMultipleRangeRequest: false, cancellationToken,
      onProgress: p => progress(p.transferred, p.total),
    }).download(oldMap, newMap);
  } finally { signal.removeEventListener("abort", cancel); }
};

/** Install only the path just re-verified against the persisted signed manifest. */
export class PreparedNsisUpdater {
  async installPrepared(path: string): Promise<void> {
    // Same NSIS arguments as NsisUpdater, but await spawn success and never
    // fall back to openPath (which would display an interactive installer).
    await new Promise<void>((resolve, reject) => {
      const child = spawn(path, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true, cwd: process.env.TEMP });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
}

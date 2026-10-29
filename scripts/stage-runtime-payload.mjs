import { chmod, cp } from "node:fs/promises";
import { join } from "node:path";
import { runtimeEntrypointFor } from "./target-platform.mjs";

/** Actions artifact downloads restore files as 0644; restore POSIX modes on the copy. */
export async function stageRuntimePayload(source, destination, platform) {
  await cp(source, destination, { recursive: true });
  if (!platform.startsWith("win32-")) {
    await chmod(join(destination, runtimeEntrypointFor(platform)), 0o755);
  }
}

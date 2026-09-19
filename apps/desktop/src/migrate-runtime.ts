import { join } from "node:path";
import { RuntimeInstaller, type ActivateOptions } from "@omp-studio/runtime-installer";
import { STUDIO_PROTOCOL_VERSION } from "@omp-studio/studio-protocol";

/** Run by the freshly installed app before the legacy machine install is removed. */
export async function migrateLegacyRuntime(input: {
  legacyInstallRoot: string; userRuntimeRoot: string;
  trustedKeys: Readonly<Record<string, string | Buffer>>;
  activateOptions?: ActivateOptions;
}): Promise<void> {
  const source = new RuntimeInstaller(join(input.legacyInstallRoot, "runtime"), { trustedKeys: input.trustedKeys });
  const current = await source.currentManifest(); // Verifies signature and actual executable before copying.
  if (!current) return;
  const target = new RuntimeInstaller(input.userRuntimeRoot, { trustedKeys: input.trustedKeys });
  if (await target.currentManifest()) return; // Respect an existing verified per-user Runtime.
  await target.install(join(source.rootDirectory, "versions", current.manifest.runtimeVersion));
  if (current.manifest.studioProtocol.min <= STUDIO_PROTOCOL_VERSION && current.manifest.studioProtocol.max >= STUDIO_PROTOCOL_VERSION) {
    await target.activate(current.manifest.runtimeVersion, input.activateOptions);
  }
  // Otherwise keep the old signed artifact for recovery; normal startup seeds
  // the compatible Runtime bundled with the new desktop.
}

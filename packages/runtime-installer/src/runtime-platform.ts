/**
 * Runtime platform table. The entrypoint follows the artifact's platform
 * (the manifest `platform`), never the machine doing the work, so a Windows
 * artifact handled on macOS keeps `omp.exe`. `scripts/target-platform.mjs`
 * mirrors this table and a metadata test keeps the two identical.
 */
export const RUNTIME_ENTRYPOINTS = Object.freeze({ win32: "omp.exe", darwin: "omp" } as const);
export type RuntimeOs = keyof typeof RUNTIME_ENTRYPOINTS;
export type RuntimeEntrypoint = (typeof RUNTIME_ENTRYPOINTS)[RuntimeOs];

/** Platforms with signed update catalogs. */
export const UPDATE_PLATFORMS = Object.freeze(["win32-x64", "win32-arm64", "darwin-arm64"] as const);
export type UpdatePlatform = (typeof UPDATE_PLATFORMS)[number];

export function runtimeOsOf(platform: string): RuntimeOs {
  const os = platform.split("-", 1)[0];
  if (os !== "win32" && os !== "darwin") throw new Error(`Unsupported Runtime platform: ${platform}`);
  return os;
}

export function runtimeEntrypointFor(platform: string): RuntimeEntrypoint {
  return RUNTIME_ENTRYPOINTS[runtimeOsOf(platform)];
}

export function isUpdatePlatform(platform: string): platform is UpdatePlatform {
  return (UPDATE_PLATFORMS as readonly string[]).includes(platform);
}

/** Desktop update payload: the NSIS installer on Windows, the zipped `.app` on macOS. */
export function appUpdateAssetSuffix(platform: UpdatePlatform): ".exe" | ".zip" {
  return runtimeOsOf(platform) === "darwin" ? ".zip" : ".exe";
}

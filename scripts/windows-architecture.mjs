import { readFileSync } from "node:fs";

export function resolveTargetArch(env = process.env, hostArch = process.arch) {
  const arch = String(env.OMP_TARGET_ARCH ?? hostArch).trim().toLowerCase();
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported Windows target architecture: ${arch}`);
  return arch;
}

// Framework csc cannot emit ARM64. The NSIS bootstrap UI runs under Windows'
// x86 emulation on ARM64; its native WebView2 loader must match that process.
// The Electron/Runtime payload remains native ARM64.
export function installerHostArch(targetArch) {
  return targetArch === "arm64" ? "x86" : "x64";
}

export function assertNativeRuntimeBuild(targetArch, hostArch = process.arch) {
  if (targetArch !== hostArch) throw new Error(`Build Runtime on a native ${targetArch} runner; this runner is ${hostArch}. Use --skip-host with a signed win32-${targetArch} artifact to package it here.`);
}

export function peArchitecture(bytes) {
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Not a Windows PE executable");
  const offset = bytes.readUInt32LE(60);
  if (offset > bytes.length - 6 || bytes.toString("ascii", offset, offset + 4) !== "PE\0\0") throw new Error("Invalid Windows PE header");
  const machine = bytes.readUInt16LE(offset + 4);
  const arch = { 0x14c: "x86", 0x8664: "x64", 0xaa64: "arm64" }[machine];
  if (!arch) throw new Error(`Unsupported PE machine: ${machine}`);
  return arch;
}

export function assertPeArchitecture(path, expected) {
  const actual = peArchitecture(readFileSync(path));
  if (actual !== expected) throw new Error(`${path}: expected ${expected} PE, found ${actual}`);
}

export function assertRuntimeManifestTarget(manifest, targetArch, runtimeVersion) {
  if (manifest.platform !== `win32-${targetArch}`) throw new Error(`Runtime platform ${manifest.platform} does not match installer target win32-${targetArch}`);
  if (manifest.runtimeVersion !== runtimeVersion) throw new Error(`Artifact runtimeVersion ${manifest.runtimeVersion} does not match series ${runtimeVersion}`);
}

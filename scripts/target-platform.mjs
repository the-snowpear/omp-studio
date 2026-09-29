import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { peArchitecture } from "./windows-architecture.mjs";

// Mirrors packages/runtime-installer/src/runtime-platform.ts; target-platform.test.mjs
// keeps the two tables identical. The entrypoint follows the artifact platform,
// never the machine running the script.
export const RUNTIME_ENTRYPOINTS = Object.freeze({ win32: "omp.exe", darwin: "omp" });
export const UPDATE_PLATFORMS = Object.freeze(["win32-x64", "win32-arm64", "darwin-arm64"]);

export function runtimeOsOf(platform) {
  const os = String(platform).split("-", 1)[0];
  if (os !== "win32" && os !== "darwin") throw new Error(`Unsupported Runtime platform: ${platform}`);
  return os;
}

export function runtimeEntrypointFor(platform) {
  return RUNTIME_ENTRYPOINTS[runtimeOsOf(platform)];
}

/** `<os>-<arch>` of the artifact being built; OMP_TARGET_PLATFORM / OMP_TARGET_ARCH override the host. */
export function resolveTargetPlatform(env = process.env, host = { platform: process.platform, arch: process.arch }) {
  const os = String(env.OMP_TARGET_PLATFORM ?? host.platform).trim().toLowerCase();
  const arch = String(env.OMP_TARGET_ARCH ?? host.arch).trim().toLowerCase();
  const target = `${os}-${arch}`;
  if (!UPDATE_PLATFORMS.includes(target)) throw new Error(`Unsupported target platform: ${target}`);
  return target;
}

const MACHO_CPU_TYPES = new Map([[0x01000007, "x64"], [0x0100000c, "arm64"]]);

/** Thin 64-bit Mach-O only: a universal binary would put two architectures behind one checksum. */
export function machOArchitecture(bytes) {
  if (bytes.length < 8) throw new Error("Not a Mach-O executable");
  const fat = bytes.readUInt32BE(0);
  if (fat === 0xcafebabe || fat === 0xcafebabf) throw new Error("Universal (fat) Mach-O is not a supported Runtime artifact");
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Not a 64-bit Mach-O executable");
  const cpuType = bytes.readUInt32LE(4);
  const arch = MACHO_CPU_TYPES.get(cpuType);
  if (!arch) throw new Error(`Unsupported Mach-O cputype: 0x${cpuType.toString(16)}`);
  return arch;
}

export function executableArchitecture(bytes, platform) {
  return runtimeOsOf(platform) === "darwin" ? machOArchitecture(bytes) : peArchitecture(bytes);
}

export function assertExecutableTarget(path, platform) {
  const expected = platform.slice(platform.indexOf("-") + 1);
  const actual = executableArchitecture(readFileSync(path), platform);
  if (actual !== expected) throw new Error(`${path}: expected a ${platform} executable, found ${actual}`);
}

/** Apple Silicon SIGKILLs a Mach-O with a missing or broken signature on exec; fail the build instead. */
export function verifyMacCodeSignature(path, run = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) {
  try {
    run("/usr/bin/codesign", ["--verify", "--strict", path]);
  } catch (error) {
    const detail = typeof error?.stderr === "string" && error.stderr.trim() ? `: ${error.stderr.trim()}` : "";
    throw new Error(`${path} has no valid code signature (codesign --verify --strict)${detail}`);
  }
}

/** An x64 Node under Rosetta reports darwin-x64 and would build and self-test the wrong Runtime. */
export function isRosettaTranslated(run = (file, args) => execFileSync(file, args, { encoding: "utf8" })) {
  try {
    return run("/usr/sbin/sysctl", ["-in", "sysctl.proc_translated"]).trim() === "1";
  } catch {
    return false;
  }
}

export function assertNativeTargetBuild(
  platform,
  host = { platform: process.platform, arch: process.arch },
  translated = host.platform === "darwin" && isRosettaTranslated(),
) {
  if (translated) throw new Error("This Node runs under Rosetta; install a native arm64 Node to build the darwin-arm64 Runtime.");
  if (platform !== `${host.platform}-${host.arch}`) {
    throw new Error(`Build the ${platform} Runtime on a native ${platform} runner; this runner is ${host.platform}-${host.arch}.`);
  }
}

export function assertRuntimeManifestPlatform(manifest, platform, runtimeVersion) {
  if (manifest.platform !== platform) throw new Error(`Runtime platform ${manifest.platform} does not match target ${platform}`);
  const entrypoint = runtimeEntrypointFor(platform);
  if (manifest.entrypoint !== entrypoint) throw new Error(`Runtime entrypoint ${manifest.entrypoint} does not match ${platform} (${entrypoint})`);
  if (manifest.runtimeVersion !== runtimeVersion) throw new Error(`Artifact runtimeVersion ${manifest.runtimeVersion} does not match series ${runtimeVersion}`);
}

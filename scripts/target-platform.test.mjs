import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as installer from "../packages/runtime-installer/dist/src/index.js";
import {
  RUNTIME_ENTRYPOINTS,
  UPDATE_PLATFORMS,
  assertExecutableTarget,
  assertNativeTargetBuild,
  assertRuntimeManifestPlatform,
  executableArchitecture,
  isRosettaTranslated,
  machOArchitecture,
  resolveTargetPlatform,
  runtimeEntrypointFor,
  verifyMacCodeSignature,
} from "./target-platform.mjs";

function machO(cpuType) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpuType, 4);
  return bytes;
}

function pe(machine) {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64, "ascii");
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

test("script and runtime-installer platform tables stay identical", () => {
  assert.deepEqual({ ...RUNTIME_ENTRYPOINTS }, { ...installer.RUNTIME_ENTRYPOINTS });
  assert.deepEqual([...UPDATE_PLATFORMS], [...installer.UPDATE_PLATFORMS]);
  for (const platform of UPDATE_PLATFORMS) assert.equal(runtimeEntrypointFor(platform), installer.runtimeEntrypointFor(platform));
});

test("target platform follows the host unless overridden, and only supported targets resolve", () => {
  assert.equal(resolveTargetPlatform({}, { platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(resolveTargetPlatform({ OMP_TARGET_ARCH: "arm64" }, { platform: "win32", arch: "x64" }), "win32-arm64");
  assert.equal(resolveTargetPlatform({ OMP_TARGET_PLATFORM: "Darwin", OMP_TARGET_ARCH: " ARM64 " }, { platform: "win32", arch: "x64" }), "darwin-arm64");
  assert.throws(() => resolveTargetPlatform({}, { platform: "darwin", arch: "x64" }), /Unsupported target platform: darwin-x64/u);
  assert.throws(() => resolveTargetPlatform({}, { platform: "linux", arch: "x64" }), /Unsupported/u);
});

test("Mach-O parsing accepts thin arm64/x64 and refuses universal or foreign files", () => {
  assert.equal(machOArchitecture(machO(0x0100000c)), "arm64");
  assert.equal(machOArchitecture(machO(0x01000007)), "x64");
  const fat = Buffer.alloc(32);
  fat.writeUInt32BE(0xcafebabe, 0);
  assert.throws(() => machOArchitecture(fat), /Universal/u);
  assert.throws(() => machOArchitecture(pe(0xaa64)), /Not a 64-bit Mach-O/u);
  assert.throws(() => machOArchitecture(machO(0x12)), /cputype/u);
  assert.throws(() => machOArchitecture(Buffer.alloc(4)), /Not a Mach-O/u);
});

test("executable architecture uses PE on Windows and Mach-O on macOS", async () => {
  assert.equal(executableArchitecture(pe(0x8664), "win32-x64"), "x64");
  assert.equal(executableArchitecture(machO(0x0100000c), "darwin-arm64"), "arm64");
  assert.throws(() => executableArchitecture(machO(0x0100000c), "win32-arm64"), /PE/u);
  const root = await mkdtemp(join(tmpdir(), "omp-target-platform-"));
  await writeFile(join(root, "omp"), machO(0x01000007));
  assert.throws(() => assertExecutableTarget(join(root, "omp"), "darwin-arm64"), /expected a darwin-arm64 executable, found x64/u);
  await writeFile(join(root, "omp"), machO(0x0100000c));
  assertExecutableTarget(join(root, "omp"), "darwin-arm64");
});

test("native build guard rejects cross builds and Rosetta", () => {
  assertNativeTargetBuild("darwin-arm64", { platform: "darwin", arch: "arm64" }, false);
  assert.throws(() => assertNativeTargetBuild("darwin-arm64", { platform: "darwin", arch: "x64" }, true), /Rosetta/u);
  assert.throws(() => assertNativeTargetBuild("darwin-arm64", { platform: "win32", arch: "arm64" }, false), /native darwin-arm64 runner/u);
  assert.equal(isRosettaTranslated(() => "1\n"), true);
  assert.equal(isRosettaTranslated(() => "0\n"), false);
  assert.equal(isRosettaTranslated(() => { throw new Error("no sysctl"); }), false);
});

test("code signature verification runs codesign strictly and reports its reason", () => {
  const calls = [];
  verifyMacCodeSignature("/tmp/omp", (file, args) => { calls.push([file, ...args]); return ""; });
  assert.deepEqual(calls, [["/usr/bin/codesign", "--verify", "--strict", "/tmp/omp"]]);
  assert.throws(
    () => verifyMacCodeSignature("/tmp/omp", () => { throw Object.assign(new Error("exit 1"), { stderr: "/tmp/omp: code object is not signed at all\n" }); }),
    /no valid code signature \(codesign --verify --strict\): \/tmp\/omp: code object is not signed at all/u,
  );
});

test("Runtime manifest must match the target platform, entrypoint and series", () => {
  const manifest = { platform: "darwin-arm64", entrypoint: "omp", runtimeVersion: "18.3.0-studio.12" };
  assertRuntimeManifestPlatform(manifest, "darwin-arm64", "18.3.0-studio.12");
  assert.throws(() => assertRuntimeManifestPlatform(manifest, "win32-arm64", "18.3.0-studio.12"), /does not match target/u);
  assert.throws(() => assertRuntimeManifestPlatform({ ...manifest, entrypoint: "omp.exe" }, "darwin-arm64", "18.3.0-studio.12"), /entrypoint/u);
  assert.throws(() => assertRuntimeManifestPlatform(manifest, "darwin-arm64", "18.3.0-studio.13"), /series/u);
});

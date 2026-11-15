import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { requiredGlibc } from "./audit-linux.mjs";
import { deriveLinuxBuilderConfig, linuxAppImageName, linuxDebName } from "./linux-bundle.mjs";
import { parseBuilderYaml } from "./mac-bundle.mjs";

const require = createRequire(import.meta.url);

test("Linux packages carry POSIX Runtime resources and retain Chromium sandboxing", () => {
  const base = parseBuilderYaml(readFileSync(new URL("../packaging/electron-builder.yml", import.meta.url), "utf8"));
  const before = structuredClone(base);
  const config = deriveLinuxBuilderConfig(base, { outputDirectory: "/out" });
  assert.deepEqual(base, before);
  assert.equal(config.win, undefined);
  assert.equal(config.nsis, undefined);
  assert.equal(config.extraFiles, undefined);
  for (const entry of base.extraFiles) assert.ok(config.extraResources.some(resource => resource.to === entry.to));
  assert.deepEqual(config.appImage.executableArgs, [], "the builder's default would disable the sandbox");
  assert.equal(config.extraMetadata.desktopName, "omp-studio.desktop");
  assert.equal(config.linux.desktop.entry.StartupWMClass, "omp-studio");
  assert.equal(config.deb.packageName, "omp-studio");
  assert.ok(config.deb.depends.includes("libc6 (>= 2.39)"));
  assert.equal(linuxAppImageName("0.2.2"), "OMP-Studio-0.2.2-linux-x64.AppImage");
  assert.equal(linuxDebName("0.2.2"), "OMP-Studio-0.2.2-linux-x64.deb");
});

test("builder container-specific architecture names match the signed Linux download names", () => {
  const { Arch, getArtifactArchName } = require("builder-util");
  const { expandMacro } = require("app-builder-lib/out/util/macroExpander.js");
  const base = parseBuilderYaml(readFileSync(new URL("../packaging/electron-builder.yml", import.meta.url), "utf8"));
  const config = deriveLinuxBuilderConfig(base, { outputDirectory: "/out" });
  for (const [target, ext, expected] of [["appImage", "AppImage", linuxAppImageName], ["deb", "deb", linuxDebName]]) {
    const name = expandMacro(config[target].artifactName, getArtifactArchName(Arch.x64, ext), { version: "0.2.2" }, { ext });
    assert.equal(name, expected("0.2.2"));
  }
});

test("packaging errors remain failures after electron-builder temporary-file cleanup", () => {
  const entry = new URL("./pack-linux.mjs", import.meta.url);
  const bootstrap = `import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(entry.href)});
    await new (require("temp-file").TmpDir)().getTempFile();
    Object.defineProperty(process, "arch", { value: "ia32" });`;
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(bootstrap)}`, fileURLToPath(entry), "--skip-host", "--skip-build"], { encoding: "utf8", timeout: 30_000 });
  assert.match(result.stderr, /Build the linux-x64 Runtime on a native linux-x64 runner/u);
  assert.equal(result.status, 1, "async-exit-hook must not turn a failed build/audit into a successful release step");
});

test("the ELF audit reports the newest required glibc version numerically", () => {
  assert.equal(requiredGlibc("Name: GLIBC_2.9 Name: GLIBC_2.39 Name: GLIBC_2.3"), "2.39");
  assert.equal(requiredGlibc("Name: GLIBCXX_3.4.32"), undefined);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { requiredGlibc } from "./audit-linux.mjs";
import { deriveLinuxBuilderConfig, linuxAppImageName, linuxDebName } from "./linux-bundle.mjs";
import { parseBuilderYaml } from "./mac-bundle.mjs";

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

test("the ELF audit reports the newest required glibc version numerically", () => {
  assert.equal(requiredGlibc("Name: GLIBC_2.9 Name: GLIBC_2.39 Name: GLIBC_2.3"), "2.39");
  assert.equal(requiredGlibc("Name: GLIBCXX_3.4.32"), undefined);
});

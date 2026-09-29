import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { auditMacOutput } from "./audit-mac.mjs";
import { MAC_USAGE_DESCRIPTIONS, MAC_USAGE_DESCRIPTIONS_ZH, buildPlist, infoPlistStrings } from "./mac-bundle.mjs";

const require = createRequire(import.meta.url);
const VERSION = "9.9.9";
const RUNTIME = "18.2.5-studio.99";

function machO(arch = "arm64") {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  return bytes;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function infoPlist({ omit = [] } = {}) {
  const info = {
    CFBundleIdentifier: "com.ompstudio.desktop",
    CFBundleShortVersionString: VERSION,
    CFBundleExecutable: "OMP Studio",
    LSMinimumSystemVersion: "13.0",
    LSApplicationCategoryType: "public.app-category.developer-tools",
    ...MAC_USAGE_DESCRIPTIONS,
  };
  for (const key of omit) delete info[key];
  return buildPlist(info);
}

async function bundle() {
  const out = mkdtempSync(join(tmpdir(), "omp-audit-mac-"));
  const app = join(out, "mac-arm64", "OMP Studio.app");
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  write(join(contents, "Info.plist"), infoPlist());
  write(join(contents, "PkgInfo"), "APPL????");
  write(join(contents, "MacOS", "OMP Studio"), machO());
  mkdirSync(join(contents, "Frameworks"), { recursive: true });
  write(join(contents, "_CodeSignature", "CodeResources"), "<plist/>");

  const appSource = join(out, "app-source");
  write(join(appSource, "package.json"), JSON.stringify({ main: "./dist/src/main.js" }));
  write(join(appSource, "dist", "preload.cjs"), "module.exports = {};");
  await require("@electron/asar").createPackage(appSource, join(resources, "app.asar"));
  rmSync(appSource, { recursive: true, force: true });

  write(join(resources, "renderer", "dist", "index.html"), '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">');
  write(join(resources, "darwin", "trayTemplate.png"), "png");
  write(join(resources, "darwin", "trayTemplate@2x.png"), "png");
  write(join(resources, "zh_CN.lproj", "InfoPlist.strings"), infoPlistStrings(MAC_USAGE_DESCRIPTIONS_ZH));

  const runtime = join(resources, "runtime", "versions", RUNTIME);
  write(join(runtime, "omp"), machO());
  write(join(runtime, "runtime-manifest.json"), JSON.stringify({ runtimeVersion: RUNTIME, platform: "darwin-arm64", entrypoint: "omp" }));
  const keys = join(resources, "runtime-keys");
  write(join(keys, "key-id.txt"), "k1\n");
  write(join(keys, "trusted-public.pem"), "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n");
  write(join(keys, "trusted-keys.json"), JSON.stringify({ schema: 1, activeKeyId: "k1", keys: { k1: "trusted-public.pem" } }));

  const pty = join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "darwin-arm64");
  write(join(pty, "pty.node"), machO());
  write(join(pty, "spawn-helper"), machO());

  write(join(out, `OMP-Studio-${VERSION}-macos-arm64.dmg`), "dmg");
  write(join(out, `OMP-Studio-${VERSION}-macos-arm64.zip`), "zip");
  return { out, app, contents, resources };
}

const EXECUTABLES = /[\\/](omp|spawn-helper|OMP Studio)$/u;

function harness(app, { fail, modeOf } = {}) {
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (fail?.(file, args)) throw new Error(`${file} ${args.join(" ")} failed with exit 1`);
    if (file === "/usr/bin/ditto" && args[0] === "-x") cpSync(app, join(args[3], "OMP Studio.app"), { recursive: true });
    if (file === "/usr/bin/codesign" && args[0] === "-dv") return "Identifier=com.ompstudio.desktop\nSignature=adhoc\n";
    return "";
  };
  return {
    calls,
    options: {
      version: VERSION,
      runtimeVersion: RUNTIME,
      exec,
      modeOf: modeOf ?? ((path) => (EXECUTABLES.test(path) ? 0o100755 : 0o100644)),
      verifyRuntime: async () => undefined,
    },
  };
}

test("a complete ad hoc bundle passes every check", async () => {
  const { out, app } = await bundle();
  const { calls, options } = harness(app);
  const report = await auditMacOutput(out, options);
  assert.equal(report.appPath, app);
  assert.ok(report.notes.some((note) => note.includes("(ad hoc)")));
  assert.ok(calls.includes(`/usr/bin/codesign --verify --deep --strict --verbose=2 ${app}`));
  assert.ok(calls.some((call) => call.startsWith("/usr/bin/codesign --verify --strict ") && call.endsWith(`${RUNTIME}${app.includes("\\") ? "\\" : "/"}omp`)));
  assert.ok(calls.some((call) => call.startsWith("/usr/bin/hdiutil verify ")));
  assert.ok(calls.some((call) => call.startsWith("/usr/bin/ditto -x -k ")));
  assert.equal(calls.filter((call) => call.startsWith("/usr/bin/codesign --verify --deep --strict")).length, 2, "the app and the copy restored from the zip");
});

test("anything outside Contents/Resources fails: the Windows extraFiles layout breaks the seal", async () => {
  const { out, app, contents } = await bundle();
  mkdirSync(join(contents, "runtime", "versions"), { recursive: true });
  await assert.rejects(() => auditMacOutput(out, harness(app).options), /Unsealed entries .*runtime/u);
});

test("a missing privacy purpose string fails before macOS would kill the app", async () => {
  const { out, app, contents } = await bundle();
  write(join(contents, "Info.plist"), infoPlist({ omit: ["NSMicrophoneUsageDescription"] }));
  await assert.rejects(() => auditMacOutput(out, harness(app).options), /NSMicrophoneUsageDescription/u);
});

test("the Runtime must stay 0755 and arm64", async () => {
  const { out, app, resources } = await bundle();
  const notExecutable = harness(app, { modeOf: (path) => (path.endsWith("omp") ? 0o100644 : 0o100755) }).options;
  await assert.rejects(() => auditMacOutput(out, notExecutable), /0755/u);
  write(join(resources, "runtime", "versions", RUNTIME, "omp"), machO("x64"));
  await assert.rejects(() => auditMacOutput(out, harness(app).options), /expected a darwin-arm64 executable/u);
});

test("Windows native payloads and a non-executable spawn-helper fail", async () => {
  const { out, app, resources } = await bundle();
  const helperMode = harness(app, { modeOf: (path) => (path.endsWith("spawn-helper") ? 0o100644 : 0o100755) }).options;
  await assert.rejects(() => auditMacOutput(out, helperMode), /spawn-helper is not executable/u);
  mkdirSync(join(resources, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "win32-x64"), { recursive: true });
  await assert.rejects(() => auditMacOutput(out, harness(app).options), /other platforms: win32-x64/u);
});

test("a failing code signature verification fails, for the app and for the zip round trip", async () => {
  const { out, app } = await bundle();
  const broken = harness(app, { fail: (file, args) => file === "/usr/bin/codesign" && args.includes("--deep") && args.at(-1) === app }).options;
  await assert.rejects(() => auditMacOutput(out, broken), /codesign/u);
  const brokenZip = harness(app, { fail: (file, args) => file === "/usr/bin/codesign" && args.includes("--deep") && args.at(-1).includes("omp-mac-zip-") }).options;
  await assert.rejects(() => auditMacOutput(out, brokenZip), /codesign/u);
  const lostBits = harness(app, { modeOf: (path) => (path.includes("omp-mac-zip-") ? 0o100644 : EXECUTABLES.test(path) ? 0o100755 : 0o100644) }).options;
  await assert.rejects(() => auditMacOutput(out, lostBits), /execute bits/u);
});

test("a private key anywhere in the bundle fails", async () => {
  const { out, app, resources } = await bundle();
  write(join(resources, "runtime", "versions", RUNTIME, "notes.txt"), "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n");
  await assert.rejects(() => auditMacOutput(out, harness(app).options), /private signing key/u);
});

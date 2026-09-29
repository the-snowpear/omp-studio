import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  ADHOC_IDENTITY,
  MAC_FILE_EXCLUSIONS,
  MAC_USAGE_DESCRIPTIONS,
  MAC_USAGE_DESCRIPTIONS_ZH,
  deriveMacBuilderConfig,
  infoPlistStrings,
  macDmgFileName,
  macSignOptions,
  macUpdateZipFileName,
  parseBuilderYaml,
  parsePlist,
} from "./mac-bundle.mjs";
import { repositoryRoot } from "./omp-tooling.mjs";

const ymlPath = join(repositoryRoot, "packaging", "electron-builder.yml");
const options = { outputDirectory: "/out", iconPath: "/res/icon.icns", localizedResourcesDirectory: "/res/localized", sign: async () => undefined };

test("the macOS config is derived from electron-builder.yml without touching the Windows input", () => {
  const text = readFileSync(ymlPath, "utf8");
  const base = parseBuilderYaml(text);
  const snapshot = structuredClone(base);
  const config = deriveMacBuilderConfig(base, options);
  assert.deepEqual(base, snapshot, "derivation must not mutate the parsed Windows config");
  assert.equal(readFileSync(ymlPath, "utf8"), text);

  for (const key of ["win", "nsis", "extraFiles", "artifactName", "forceCodeSigning"]) assert.equal(key in config, false, key);
  assert.equal(config.publish, null);
  assert.equal(config.appId, base.appId);
  assert.equal(config.productName, base.productName);
  assert.equal(config.directories.app, base.directories.app);
  assert.equal(config.directories.output, "/out");
  assert.deepEqual(config.files, [...base.files, ...MAC_FILE_EXCLUSIONS]);
  assert.equal(config.asarUnpack.some((pattern) => pattern.endsWith(".ico")), false);
});

test("the Runtime payload and keys move from extraFiles into Contents/Resources with the same filters", () => {
  const base = parseBuilderYaml(readFileSync(ymlPath, "utf8"));
  const config = deriveMacBuilderConfig(base, options);
  for (const entry of base.extraFiles) assert.ok(config.extraResources.some((resource) => JSON.stringify(resource) === JSON.stringify(entry)), entry.to);
  assert.ok(config.extraResources.some((entry) => entry.to === "runtime/versions" && entry.filter.includes("!signing-private.pem")));
  assert.ok(config.extraResources.some((entry) => entry.from === "apps/desktop/resources-darwin" && entry.to === "darwin"));
  assert.ok(config.extraResources.some((entry) => entry.from === join("/res/localized", "zh_CN.lproj") && entry.to === "zh_CN.lproj" && entry.filter.includes("InfoPlist.strings")));
  assert.equal(config.extraResources.some((entry) => String(entry.from).endsWith(".ico")), false);
  assert.throws(() => deriveMacBuilderConfig({ ...base, extraFiles: undefined }, options), /extraFiles/u);
});

test("mac settings: arm64 dmg, ad hoc identity through the custom signer, macOS 13, every purpose string", () => {
  const config = deriveMacBuilderConfig(parseBuilderYaml(readFileSync(ymlPath, "utf8")), options);
  assert.deepEqual(config.mac.target, [{ target: "dmg", arch: ["arm64"] }]);
  assert.equal(config.mac.identity, ADHOC_IDENTITY);
  assert.equal(config.mac.sign, options.sign);
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.minimumSystemVersion, "13.0");
  assert.equal(config.mac.category, "public.app-category.developer-tools");
  assert.equal(config.mac.icon, "/res/icon.icns");
  assert.deepEqual(config.mac.extendInfo, MAC_USAGE_DESCRIPTIONS);
  assert.equal(config.dmg.sign, false);
  assert.equal(config.dmg.writeUpdateInfo, false);
  assert.equal(config.mac.artifactName, "OMP-Studio-${version}-macos-${arch}.${ext}");
});

test("artifact names follow the macos-arm64 release naming", () => {
  assert.equal(macDmgFileName("0.1.7"), "OMP-Studio-0.1.7-macos-arm64.dmg");
  assert.equal(macUpdateZipFileName("0.1.7"), "OMP-Studio-0.1.7-macos-arm64.zip");
});

test("the signer never touches the Runtime payload and keeps the hardened runtime off for ad hoc", () => {
  const app = "/out/mac-arm64/OMP Studio.app";
  const sign = macSignOptions({ app, version: "43.4.0", entitlements: "/m.plist", entitlementsInherit: "/i.plist" });
  assert.equal(sign.identity, "-");
  assert.equal(sign.identityValidation, false);
  assert.equal(sign.preAutoEntitlements, false);
  assert.equal(sign.ignore(`${app}/Contents/Resources/runtime/versions/18.2.5-studio.13/omp`), true);
  assert.equal(sign.ignore(`${app}/Contents/Resources/runtime/versions/18.2.5-studio.13/checksums.json`), true);
  assert.equal(sign.ignore("C:\\out\\OMP Studio.app\\Contents\\Resources\\runtime\\versions\\x\\omp"), true);
  assert.equal(sign.ignore(`${app}/Contents/Frameworks/Electron Framework.framework`), false);
  assert.equal(sign.ignore(`${app}/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper`), false);
  assert.deepEqual(sign.optionsForFile(app), { hardenedRuntime: false, entitlements: "/m.plist", timestamp: "none" });
  assert.deepEqual(sign.optionsForFile(`${app}/Contents/Frameworks/OMP Studio Helper (Renderer).app`), { hardenedRuntime: false, entitlements: "/i.plist", timestamp: "none" });
  const developerId = macSignOptions({ app, identity: "Developer ID Application: Example (TEAM123456)", entitlements: "/m.plist", entitlementsInherit: "/i.plist", hardenedRuntime: true });
  assert.deepEqual(developerId.optionsForFile(app), { hardenedRuntime: true, entitlements: "/m.plist" });
});

test("purpose strings: both languages cover the same keys and the strings table escapes quotes", () => {
  assert.deepEqual(Object.keys(MAC_USAGE_DESCRIPTIONS_ZH).sort(), Object.keys(MAC_USAGE_DESCRIPTIONS).sort());
  assert.ok(Object.values(MAC_USAGE_DESCRIPTIONS).every((value) => value.length > 20));
  assert.equal(infoPlistStrings({ Key: 'say "hi"\\now' }), '"Key" = "say \\"hi\\"\\\\now";\n');
  const zh = infoPlistStrings(MAC_USAGE_DESCRIPTIONS_ZH);
  assert.match(zh, /^"NSMicrophoneUsageDescription" = "OMP Studio 使用麦克风/mu);
});

test("the committed entitlements parse and grant JIT and audio input", () => {
  for (const name of ["entitlements.mac.plist", "entitlements.mac.inherit.plist"]) {
    const plist = parsePlist(readFileSync(join(repositoryRoot, "packaging", "mac", name), "utf8"));
    assert.equal(plist["com.apple.security.cs.allow-jit"], true, name);
    assert.equal(plist["com.apple.security.device.audio-input"], true, name);
  }
});

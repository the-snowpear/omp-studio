import { createRequire } from "node:module";
import { downloadWebView2Sdk } from "./build-installer-host.mjs";
import { assertLockedElectronVersion } from "./release-cache.mjs";
import { resolveTargetArch } from "./windows-architecture.mjs";

const require = createRequire(import.meta.url);
const { downloadElectronArtifactZip } = require("app-builder-lib/out/util/electronGet.js");
const version = assertLockedElectronVersion();
const windows = process.platform === "win32" ? require("app-builder-lib/out/toolsets/windows.js") : undefined;
await Promise.all([
  ...(windows ? [windows.getMakeNsisPath(), windows.getNsisPluginsPath(), downloadWebView2Sdk()] : []),
  downloadElectronArtifactZip({ artifactName: "electron", platformName: process.platform, arch: resolveTargetArch(), version }),
]);
console.log(`Electron ${version} downloads ready (${process.platform}-${resolveTargetArch()})${windows ? ", including NSIS and WebView2" : ""}`);

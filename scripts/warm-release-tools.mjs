import { createRequire } from "node:module";
import { downloadWebView2Sdk } from "./build-installer-host.mjs";
import { assertLockedElectronVersion } from "./release-cache.mjs";
import { resolveTargetArch } from "./windows-architecture.mjs";

const require = createRequire(import.meta.url);
const windows = require("app-builder-lib/out/toolsets/windows.js");
const { downloadElectronArtifactZip } = require("app-builder-lib/out/util/electronGet.js");
const version = assertLockedElectronVersion();
await Promise.all([
  windows.getMakeNsisPath(),
  windows.getNsisPluginsPath(),
  downloadWebView2Sdk(),
  downloadElectronArtifactZip({ artifactName: "electron", platformName: "win32", arch: resolveTargetArch(), version }),
]);
console.log(`Electron ${version}, NSIS and WebView2 downloads ready`);

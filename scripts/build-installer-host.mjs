/**
 * Build the WebView2 installer UI host and stage it for NSIS.
 *
 *   node scripts/build-installer-host.mjs
 *
 * Downloads a pinned Microsoft.Web.WebView2 nupkg on first run (cached),
 * compiles InstallerHost.cs with Framework csc, and copies the exe + DLLs
 * plus the HTML wizard into packaging/resources so makensis can File them.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryRoot, run } from "./omp-tooling.mjs";
import { resolveTargetArch, installerHostArch, assertPeArchitecture } from "./windows-architecture.mjs";
export { resolveTargetArch } from "./windows-architecture.mjs";
import {
  SERIES_JSON_PATH,
  VENDOR_CODING_AGENT_PACKAGE_JSON,
  deriveRuntimeVersion,
} from "./runtime-artifact.mjs";

export const WEBVIEW2_VERSION = "1.0.2903.40";

/** Resolve the target Windows architecture used for all installer resources. */

const HOST_SRC = join(repositoryRoot, "packaging", "installer-host");
const HOST_CS = join(HOST_SRC, "InstallerHost.cs");
const CACHE_DIR = join(HOST_SRC, ".cache");
const DIST_DIR = join(HOST_SRC, "dist");
const RESOURCES_HOST = join(repositoryRoot, "packaging", "resources", "installer-host");
const RESOURCES_UI = join(repositoryRoot, "packaging", "resources", "installer-ui");
const UI_SRC = join(repositoryRoot, "packaging", "ui");

function findCsc() {
  const roots = [
    join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const found = roots.find((path) => existsSync(path));
  if (!found) {
    throw new Error("Framework csc.exe was not found. .NET Framework 4.x is required to build the installer UI host.");
  }
  return found;
}

function nupkgUrl(version) {
  const name = "microsoft.web.webview2";
  return `https://api.nuget.org/v3-flatcontainer/${name}/${version}/${name}.${version}.nupkg`;
}

async function ensureNupkg(version) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const nupkg = join(CACHE_DIR, `microsoft.web.webview2.${version}.nupkg`);
  if (existsSync(nupkg) && readFileSync(nupkg).length > 1024) return nupkg;

  const url = nupkgUrl(version);
  console.log(`[installer-host] Downloading WebView2 ${version}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`WebView2 NuGet download failed: ${response.status} ${url}`);
  }
  writeFileSync(nupkg, Buffer.from(await response.arrayBuffer()));
  return nupkg;
}

function extractNupkg(nupkg, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const tar = spawnSync("tar", ["-xf", nupkg, "-C", dest], { encoding: "utf8" });
  if (tar.status !== 0) {
    throw new Error(`Failed to extract WebView2 nupkg: ${tar.stderr || tar.stdout}`);
  }
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} missing: ${path}`);
  return path;
}

function copyUi() {
  mkdirSync(RESOURCES_UI, { recursive: true });
  for (const name of ["index.html", "styles.css"]) {
    copyFileSync(join(UI_SRC, name), join(RESOURCES_UI, name));
  }
  const productIcon = join(repositoryRoot, "icon.png");
  copyFileSync(
    existsSync(productIcon) ? productIcon : join(UI_SRC, "app-icon.png"),
    join(RESOURCES_UI, "app-icon.png"),
  );
}

function writeHostDefaults() {
  const series = JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8"));
  const vendor = JSON.parse(readFileSync(VENDOR_CODING_AGENT_PACKAGE_JSON, "utf8"));
  const runtimeVersion = deriveRuntimeVersion(vendor.version, series);
  const product = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const arch = resolveTargetArch();
  const ini = `[Setup]
Version=${product.version}
RuntimeVersion=${runtimeVersion}
ProductName=OMP Studio
Arch=${arch}
InstallerHostArch=${installerHostArch(arch)}
RuntimeArch=${arch}
SpaceRequiredMB=350
AppExe=OMP Studio.exe
UninstallExe=Uninstall OMP Studio.exe
`;
  writeFileSync(join(DIST_DIR, "host-defaults.ini"), ini, "utf8");
  writeFileSync(
    join(DIST_DIR, "runtime-version.nsh"),
    `!define OMP_RUNTIME_VERSION "${runtimeVersion}"\n!define OMP_TARGET_ARCH "${arch}"\n`,
    "utf8",
  );
}

function stageResources() {
  rmSync(RESOURCES_HOST, { recursive: true, force: true });
  mkdirSync(RESOURCES_HOST, { recursive: true });
  for (const name of [
    "OmpInstallerUi.exe",
    "OmpInstallerUi.exe.config",
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.dll",
    "host-defaults.ini",
    "runtime-version.nsh",
  ]) {
    copyFileSync(join(DIST_DIR, name), join(RESOURCES_HOST, name));
  }
  copyUi();
}

function writeExeConfig(path) {
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <startup>
    <supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.7.2"/>
  </startup>
</configuration>
`,
    "utf8",
  );
}

export async function buildInstallerHost() {
  if (process.platform !== "win32") {
    throw new Error("Installer UI host is Windows-only.");
  }
  requireFile(HOST_CS, "InstallerHost.cs");
  const csc = findCsc();
  const extractDir = join(CACHE_DIR, `webview2-${WEBVIEW2_VERSION}`);
  const nupkg = await ensureNupkg(WEBVIEW2_VERSION);
  const extractedCore = join(extractDir, "lib", "net462", "Microsoft.Web.WebView2.Core.dll");
  const extractedCore45 = join(extractDir, "lib", "net45", "Microsoft.Web.WebView2.Core.dll");
  if (!existsSync(extractedCore) && !existsSync(extractedCore45)) {
    extractNupkg(nupkg, extractDir);
  }

  const coreCandidates = [
    join(extractDir, "lib", "net462", "Microsoft.Web.WebView2.Core.dll"),
    join(extractDir, "lib", "net45", "Microsoft.Web.WebView2.Core.dll"),
  ];
  const formsCandidates = [
    join(extractDir, "lib", "net462", "Microsoft.Web.WebView2.WinForms.dll"),
    join(extractDir, "lib", "net45", "Microsoft.Web.WebView2.WinForms.dll"),
  ];
  const coreDll = requireFile(
    coreCandidates.find((path) => existsSync(path)) ?? coreCandidates[0],
    "WebView2.Core",
  );
  const formsDll = requireFile(
    formsCandidates.find((path) => existsSync(path)) ?? formsCandidates[0],
    "WebView2.WinForms",
  );
  const targetArch = resolveTargetArch();
  const hostArch = installerHostArch(targetArch);
  const loaderDll = requireFile(
    join(extractDir, "runtimes", `win-${hostArch}`, "native", "WebView2Loader.dll"),
    `WebView2Loader (${hostArch})`,
  );
  assertPeArchitecture(loaderDll, hostArch);

  rmSync(DIST_DIR, { recursive: true, force: true });
  mkdirSync(DIST_DIR, { recursive: true });
  copyFileSync(coreDll, join(DIST_DIR, "Microsoft.Web.WebView2.Core.dll"));
  copyFileSync(formsDll, join(DIST_DIR, "Microsoft.Web.WebView2.WinForms.dll"));
  copyFileSync(loaderDll, join(DIST_DIR, "WebView2Loader.dll"));
  writeExeConfig(join(DIST_DIR, "OmpInstallerUi.exe.config"));
  writeHostDefaults();

  const icon = join(repositoryRoot, "apps", "desktop", "resources", "icon.ico");
  const manifest = join(HOST_SRC, "app.manifest");
  const outExe = join(DIST_DIR, "OmpInstallerUi.exe");
  const args = [
    "/nologo",
    "/warn:0",
    "/target:winexe",
    `/platform:${hostArch}`,
    "/optimize+",
    `/out:${outExe}`,
    `/reference:${coreDll}`,
    `/reference:${formsDll}`,
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    HOST_CS,
  ];
  if (existsSync(icon)) args.splice(5, 0, `/win32icon:${icon}`);
  if (existsSync(manifest)) args.splice(existsSync(icon) ? 6 : 5, 0, `/win32manifest:${manifest}`);

  console.log("[installer-host] Compiling OmpInstallerUi.exe...");
  run(csc, args, { cwd: DIST_DIR });
  if (!existsSync(outExe)) {
    throw new Error("csc did not emit OmpInstallerUi.exe");
  }
  assertPeArchitecture(outExe, hostArch);

  stageResources();
  console.log(`[installer-host] Staged ${RESOURCES_HOST} and ${RESOURCES_UI}`);
  return { exe: outExe, resourcesHost: RESOURCES_HOST, resourcesUi: RESOURCES_UI };
}

const invoked = process.argv[1];
if (
  invoked !== undefined &&
  fileURLToPath(import.meta.url).toLowerCase() === invoked.toLowerCase()
) {
  buildInstallerHost().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

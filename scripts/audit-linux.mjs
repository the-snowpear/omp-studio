/** Audit executable architecture, signed resources and both distributed Linux containers. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicRuntimeKeys, findPrivateKeyFiles } from "./audit-installer.mjs";
import { LINUX_DESKTOP_FILE, LINUX_EXECUTABLE, LINUX_INSTALL_DIRECTORY, LINUX_MIN_GLIBC, LINUX_PACKAGE_NAME, LINUX_TARGET_PLATFORM, LINUX_UNPACKED_DIRECTORY, linuxAppImageName, linuxDebName } from "./linux-bundle.mjs";
import { REPOSITORY_ROOT, SERIES_JSON_PATH, VENDOR_CODING_AGENT_PACKAGE_JSON, deriveRuntimeVersion } from "./runtime-artifact.mjs";
import { assertExecutableTarget, assertRuntimeManifestPlatform } from "./target-platform.mjs";

const require = createRequire(import.meta.url);
const exec = (file, args, options = {}) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, ...options });

export function defaultLinuxOutputDirectory() {
  return resolve(REPOSITORY_ROOT, process.env.OMP_PACK_OUTPUT_DIR ?? "outputs/installer-linux");
}

function requireFile(path) {
  if (!statSync(path).isFile()) throw new Error(`Missing packaged file: ${path}`);
  return path;
}

function executable(path) {
  requireFile(path);
  assertExecutableTarget(path, LINUX_TARGET_PLATFORM);
  if ((statSync(path).mode & 0o111) !== 0o111) throw new Error(`Packaged executable has lost its execute bits: ${path}`);
}

export function requiredGlibc(text) {
  return requiredSymbolVersion(text, "GLIBC");
}

function requiredSymbolVersion(text, library) {
  return [...text.matchAll(new RegExp(`\\b${library}_(\\d+(?:\\.\\d+)+)\\b`, "gu"))]
    .map(match => match[1]).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
}

function checkGlibc(path) {
  const symbols = exec("readelf", ["--version-info", path]);
  for (const [library, baseline] of [["GLIBC", LINUX_MIN_GLIBC], ["GLIBCXX", "3.4.32"]]) {
    const required = requiredSymbolVersion(symbols, library);
    if (required && required.localeCompare(baseline, undefined, { numeric: true }) > 0) {
      throw new Error(`${path} requires ${library} ${required}; Linux installers promise ${baseline}`);
    }
  }
}

async function auditAppDirectory(appPath, version, runtimeVersion) {
  const main = join(appPath, LINUX_EXECUTABLE);
  executable(main);
  executable(join(appPath, "chrome-sandbox"));
  const resources = join(appPath, "resources");
  const asar = require("@electron/asar"), archive = requireFile(join(resources, "app.asar"));
  const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  if (pkg.version !== version || pkg.main !== "./dist/src/main.js" || pkg.desktopName !== LINUX_DESKTOP_FILE) throw new Error("Packaged app identity/entrypoint mismatch");
  if (!asar.extractFile(archive, "dist/preload.cjs").length) throw new Error("Missing sandboxed preload");
  const renderer = readFileSync(requireFile(join(resources, "renderer/dist/index.html")), "utf8");
  if (!renderer.includes("Content-Security-Policy")) throw new Error("Packaged renderer has no CSP");
  requireFile(join(resources, "icon.png"));
  requireFile(join(resources, "ssh-askpass/askpass.cjs"));
  const versionsRoot = join(resources, "runtime/versions");
  const versions = readdirSync(versionsRoot).filter(name => !name.startsWith("."));
  if (versions.length !== 1 || versions[0] !== runtimeVersion) throw new Error(`Expected exactly Runtime ${runtimeVersion}; found ${versions}`);
  const runtime = join(versionsRoot, runtimeVersion), omp = join(runtime, "omp");
  assertRuntimeManifestPlatform(JSON.parse(readFileSync(join(runtime, "runtime-manifest.json"), "utf8")), LINUX_TARGET_PLATFORM, runtimeVersion);
  executable(omp);
  const keysDirectory = join(resources, "runtime-keys");
  assertPublicRuntimeKeys(keysDirectory);
  const table = JSON.parse(readFileSync(join(keysDirectory, "trusted-keys.json"), "utf8"));
  const keys = Object.fromEntries(Object.entries(table.keys).map(([id, name]) => [id, readFileSync(join(keysDirectory, name))]));
  const { verifySignedArtifact, RUNTIME_ARTIFACT_LAYOUT, parseRuntimeInstallationManifest } = await import("@omp-studio/runtime-installer");
  await verifySignedArtifact({ directory: runtime, trustedKeys: keys, layout: RUNTIME_ARTIFACT_LAYOUT, parseManifest: parseRuntimeInstallationManifest, requireCovered: m => ["runtime-manifest.json", m.entrypoint] });
  const pty = join(resources, "app.asar.unpacked/node_modules/node-pty");
  const nativeDirectory = [join(pty, "build/Release"), join(pty, "prebuilds/linux-x64")].find(path => existsSync(join(path, "pty.node")));
  if (!nativeDirectory) throw new Error("No unpacked Linux node-pty module");
  const native = join(nativeDirectory, "pty.node");
  assertExecutableTarget(native, LINUX_TARGET_PLATFORM);
  const helper = join(nativeDirectory, "spawn-helper");
  if (existsSync(helper)) executable(helper);
  const prebuilds = join(pty, "prebuilds");
  if (existsSync(prebuilds) && readdirSync(prebuilds).some(name => name !== LINUX_TARGET_PLATFORM)) throw new Error("Foreign node-pty prebuilds leaked into the Linux package");
  const leaked = findPrivateKeyFiles(appPath);
  if (leaked.length) throw new Error(`Private signing material in package: ${leaked.join(", ")}`);
  if (existsSync(join(resources, "app.asar.unpacked/node_modules/@omp-studio/runtime-installer/dist/artifacts"))) throw new Error("Runtime build cache leaked into app.asar.unpacked");
  for (const binary of [main, omp, native]) checkGlibc(binary);
}

function auditDesktopFile(path) {
  const text = readFileSync(requireFile(path), "utf8");
  if (/--no-sandbox|--disable-setuid-sandbox/u.test(text)) throw new Error("Desktop launcher disables Chromium's sandbox");
  if (!text.includes(`StartupWMClass=${LINUX_EXECUTABLE}`)) throw new Error("Desktop entry does not match Electron's application identity");
  exec("desktop-file-validate", [path]);
}

export async function auditLinuxOutput(outputDirectory = defaultLinuxOutputDirectory()) {
  if (process.platform !== "linux") throw new Error("Audit Linux packages on Linux");
  const version = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "apps/desktop/package.json"), "utf8")).version;
  const runtimeVersion = deriveRuntimeVersion(JSON.parse(readFileSync(VENDOR_CODING_AGENT_PACKAGE_JSON, "utf8")).version, JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8")));
  const appPath = join(outputDirectory, LINUX_UNPACKED_DIRECTORY);
  await auditAppDirectory(appPath, version, runtimeVersion);
  const appImagePath = requireFile(join(outputDirectory, linuxAppImageName(version)));
  const debPath = requireFile(join(outputDirectory, linuxDebName(version)));
  for (const file of [appImagePath, debPath]) if (statSync(file).size > 750 * 1024 * 1024) throw new Error(`Unexpectedly large installer: ${file}`);
  executable(appImagePath);
  const expected = { Package: LINUX_PACKAGE_NAME, Version: version, Architecture: "amd64" };
  for (const [field, value] of Object.entries(expected)) if (exec("dpkg-deb", ["--field", debPath, field]).trim() !== value) throw new Error(`deb ${field} mismatch`);
  const temporary = mkdtempSync(join(tmpdir(), "omp-linux-audit-"));
  try {
    exec(appImagePath, ["--appimage-extract"], { cwd: temporary });
    const imageRoot = join(temporary, "squashfs-root");
    await auditAppDirectory(imageRoot, version, runtimeVersion);
    auditDesktopFile(join(imageRoot, LINUX_DESKTOP_FILE));
    const debRoot = join(temporary, "deb");
    exec("dpkg-deb", ["--extract", debPath, debRoot]);
    await auditAppDirectory(join(debRoot, LINUX_INSTALL_DIRECTORY), version, runtimeVersion);
    auditDesktopFile(join(debRoot, "usr/share/applications", LINUX_DESKTOP_FILE));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return { appPath, appImagePath, debPath, notes: [
    `Linux x64, glibc <= ${LINUX_MIN_GLIBC}, desktop entry and Chromium sandbox`,
    `Runtime ${runtimeVersion}: bundled resource layout, executable mode, Ed25519 signature and checksums`,
    "Renderer, sandboxed preload, icons, SSH helper and unpacked native PTY",
    "AppImage and deb extracted and audited independently; no private signing keys",
  ] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditLinuxOutput().then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
}

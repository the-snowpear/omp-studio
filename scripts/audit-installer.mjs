/**
 * Fail-closed audit of electron-builder NSIS output.
 *
 * Defends the 0.1.0 installer contracts:
 * - Setup exe and win-unpacked tree exist
 * - Renderer extraResources path matches resolveRendererEntry
 * - Sandboxed preload is inside the asar
 * - Signed Runtime + public key only (never signing-private.pem)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { REPOSITORY_ROOT, SERIES_JSON_PATH, VENDOR_CODING_AGENT_PACKAGE_JSON, deriveRuntimeVersion } from "./runtime-artifact.mjs";
import { RUNTIME_PRIVATE_KEY_FILE, RUNTIME_PUBLIC_KEY_FILE } from "./runtime-signing-keys.mjs";

export const PRIVATE_KEY_MARKERS = Object.freeze([
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
]);

const TEXT_SUFFIXES = new Set([".pem", ".txt", ".json", ".yml", ".yaml", ".md", ".html", ".js", ".cjs", ".mjs", ".css"]);

export function defaultInstallerOutputDirectory() {
  return join(REPOSITORY_ROOT, "outputs", "installer");
}

function walkFiles(root) {
  /** @type {string[]} */
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (entry.isFile()) files.push(path);
    }
  }
  return files;
}

function containsPrivateKeyMarker(text) {
  return PRIVATE_KEY_MARKERS.some((marker) => text.includes(marker));
}

/**
 * @param {string} root
 * @returns {string[]} relative paths that look like a private key
 */
export function findPrivateKeyFiles(root) {
  const hits = [];
  for (const file of walkFiles(root)) {
    const name = file.replace(/\\/g, "/").split("/").pop() ?? "";
    if (name === RUNTIME_PRIVATE_KEY_FILE || name === "signing-private.pem") {
      hits.push(relative(root, file));
      continue;
    }
    const dot = name.lastIndexOf(".");
    const suffix = dot >= 0 ? name.slice(dot).toLowerCase() : "";
    if (!TEXT_SUFFIXES.has(suffix)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (containsPrivateKeyMarker(text)) hits.push(relative(root, file));
  }
  return hits;
}

function formatSize(path) {
  const bytes = statSync(path).size;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * @param {string} outputDir
 * @returns {{ installerExe: string, unpackedDir: string, notes: string[] }}
 */
export function auditInstallerOutput(outputDir = defaultInstallerOutputDirectory()) {
  const notes = [];
  if (!existsSync(outputDir)) {
    throw new Error(`Installer output directory is missing: ${outputDir}`);
  }

  const unpackedDir = join(outputDir, "win-unpacked");
  if (!existsSync(unpackedDir)) {
    throw new Error(`win-unpacked is missing under ${outputDir}. electron-builder did not finish.`);
  }

  const appExe = join(unpackedDir, "OMP Studio.exe");
  if (!existsSync(appExe)) {
    throw new Error(`Packaged executable missing: ${appExe}`);
  }
  notes.push(`app exe ${formatSize(appExe)}`);

  const rendererIndex = join(unpackedDir, "resources", "renderer", "dist", "index.html");
  if (!existsSync(rendererIndex)) {
    throw new Error(
      `Renderer extraResources missing at ${rendererIndex}. Packaged app would white-screen.`,
    );
  }
  const rendererHtml = readFileSync(rendererIndex, "utf8");
  if (!rendererHtml.includes("Content-Security-Policy")) {
    throw new Error("Packaged renderer index.html has no Content-Security-Policy meta tag.");
  }
  notes.push("renderer extraResources + CSP");

  const asarPath = join(unpackedDir, "resources", "app.asar");
  const unpackedApp = join(unpackedDir, "resources", "app");
  const preloadUnpacked = join(unpackedDir, "resources", "app.asar.unpacked", "dist", "preload.cjs");
  let preloadOk = existsSync(preloadUnpacked) || existsSync(join(unpackedApp, "dist", "preload.cjs"));
  if (!preloadOk && existsSync(asarPath)) {
    preloadOk = readFileSync(asarPath).includes(Buffer.from("preload.cjs"));
  }
  if (!preloadOk) {
    throw new Error("Sandboxed preload dist/preload.cjs is not in the packaged app.");
  }
  notes.push("preload.cjs present");

  const versionsRoot = join(unpackedDir, "runtime", "versions");
  if (!existsSync(versionsRoot)) {
    throw new Error(`Runtime extraFiles missing at ${versionsRoot}`);
  }
  const versionDirs = readdirSync(versionsRoot, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  if (versionDirs.length !== 1) {
    throw new Error(
      `Installer must ship exactly one Runtime version; found ${versionDirs.map((entry) => entry.name).join(", ") || "(none)"}`,
    );
  }
  const series = JSON.parse(readFileSync(SERIES_JSON_PATH, "utf8"));
  const vendorPkg = JSON.parse(readFileSync(VENDOR_CODING_AGENT_PACKAGE_JSON, "utf8"));
  const expectedVersion = deriveRuntimeVersion(vendorPkg.version, series);
  const packedVersion = versionDirs[0].name;
  if (packedVersion !== expectedVersion) {
    throw new Error(`Packed Runtime is ${packedVersion}; series expects ${expectedVersion}`);
  }
  const omp = join(versionsRoot, packedVersion, "omp.exe");
  const manifest = join(versionsRoot, packedVersion, "runtime-manifest.json");
  if (!existsSync(omp) || !existsSync(manifest)) {
    throw new Error("No signed Runtime folder with omp.exe + runtime-manifest.json");
  }
  const packedManifest = JSON.parse(readFileSync(manifest, "utf8"));
  if (packedManifest.runtimeVersion !== packedVersion) {
    throw new Error(
      `Packed Runtime folder ${packedVersion} does not match manifest ${packedManifest.runtimeVersion}`,
    );
  }
  notes.push(`runtime ${packedVersion} ${formatSize(omp)}`);

  const keysDir = join(unpackedDir, "runtime-keys");
  const publicKeyPath = join(keysDir, RUNTIME_PUBLIC_KEY_FILE);
  const keyIdPath = join(keysDir, "key-id.txt");
  if (!existsSync(publicKeyPath) || !existsSync(keyIdPath)) {
    throw new Error(`Packaged Runtime public key files missing under ${keysDir}`);
  }
  const publicKey = readFileSync(publicKeyPath, "utf8");
  if (!publicKey.includes("BEGIN PUBLIC KEY")) {
    throw new Error("Packaged trusted-public.pem is not an SPKI public key");
  }
  if (containsPrivateKeyMarker(publicKey)) {
    throw new Error("Packaged trusted-public.pem contains a private key marker");
  }
  notes.push("runtime public key only");

  const leakedArtifacts = join(
    unpackedDir,
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "@omp-studio",
    "runtime-installer",
    "dist",
    "artifacts",
  );
  if (existsSync(leakedArtifacts)) {
    throw new Error(
      `Runtime artifact cache leaked into asar.unpacked: ${leakedArtifacts}. Exclude **/dist/artifacts/** from electron-builder files.`,
    );
  }

  const keyHits = findPrivateKeyFiles(unpackedDir);
  if (keyHits.length > 0) {
    throw new Error(`Refusing to ship a private signing key in the installer:\n${keyHits.join("\n")}`);
  }

  const setupExes = readdirSync(outputDir)
    .filter((name) => name.toLowerCase().endsWith(".exe") && /setup/i.test(name))
    .map((name) => join(outputDir, name));
  if (setupExes.length === 0) {
    throw new Error(`NSIS Setup exe missing under ${outputDir}`);
  }
  const installerExe = setupExes.sort()[setupExes.length - 1];
  const setupBytes = readFileSync(installerExe);
  if (PRIVATE_KEY_MARKERS.some((marker) => setupBytes.includes(marker))) {
    throw new Error(`NSIS Setup exe embeds a private key marker: ${installerExe}`);
  }
  const setupSize = statSync(installerExe).size;
  if (setupSize > 400 * 1024 * 1024) {
    throw new Error(
      `NSIS Setup is ${(setupSize / (1024 * 1024)).toFixed(0)} MB; a Runtime artifact cache probably leaked into the asar`,
    );
  }
  notes.push(`setup ${formatSize(installerExe)}`);

  return { installerExe, unpackedDir, notes };
}

const invoked = process.argv[1];
if (invoked !== undefined && fileURLToPath(import.meta.url).toLowerCase() === invoked.toLowerCase()) {
  try {
    const report = auditInstallerOutput();
    console.log(`Installer audit passed: ${report.installerExe}`);
    for (const line of report.notes) console.log(`  ${line}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
